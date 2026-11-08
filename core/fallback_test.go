package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/common/interrupt"
	"github.com/sagernet/sing-box/common/urltest"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/group"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

func TestPriorityTransitions(t *testing.T) {
	s := priorityState{selected: -1, success: make([]int, 3), recovery: 2}
	cases := []struct {
		alive []bool
		want  int
	}{
		{[]bool{true, true, true}, 0}, // RTT is irrelevant between tiers.
		{[]bool{false, true, true}, 1},
		{[]bool{true, true, true}, 1},  // One recovery success does not preempt.
		{[]bool{false, true, true}, 1}, // A failed recovery resets the streak.
		{[]bool{true, true, true}, 1},
		{[]bool{true, true, true}, 0},
		{[]bool{false, false, true}, 2},
		{[]bool{false, false, false}, -1},
		{[]bool{false, true, true}, 1}, // No active tier: do not wait for recovery.
	}
	for i, c := range cases {
		if got := s.update(c.alive); got != c.want {
			t.Fatalf("step %d: got %d, want %d", i, got, c.want)
		}
	}
}

func TestFallbackValidation(t *testing.T) {
	for _, options := range []FallbackOptions{
		{}, {Outbounds: []string{"a", "a"}}, {Outbounds: []string{"vpn"}},
		{Outbounds: []string{"a"}, URL: "[https://example.test](https://example.test)"},
		{Outbounds: []string{"a"}, RecoveryChecks: -1},
	} {
		if _, err := newFallback(context.Background(), nil, log.NewNOPFactory().Logger(), "vpn", options); err == nil {
			t.Fatalf("accepted invalid options: %+v", options)
		}
	}
}

type testProxy struct {
	outbound.Adapter
	available atomic.Bool
	delay     time.Duration
	dials     atomic.Int32
}

func (p *testProxy) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	p.dials.Add(1)
	if !p.available.Load() {
		return nil, fmt.Errorf("test proxy down")
	}
	if p.delay > 0 {
		timer := time.NewTimer(p.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return (&net.Dialer{}).DialContext(ctx, network, destination.String())
}
func (p *testProxy) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, fmt.Errorf("unused")
}
func proxy(tag string, up bool) *testProxy {
	p := &testProxy{Adapter: outbound.NewAdapter("test", tag, []string{N.NetworkTCP, N.NetworkUDP}, nil)}
	p.available.Store(up)
	return p
}

type testManager struct{ members map[string]adapter.Outbound }

func (m *testManager) Start(adapter.StartStage, *adapter.Scope) error { return nil }
func (m *testManager) Outbounds() []adapter.Outbound {
	var all []adapter.Outbound
	for _, v := range m.members {
		all = append(all, v)
	}
	return all
}
func (m *testManager) Outbound(tag string) (adapter.Outbound, bool) {
	v, ok := m.members[tag]
	return v, ok
}
func (m *testManager) Default() adapter.Outbound { return nil }
func (m *testManager) Create(context.Context, adapter.Router, log.ContextLogger, string, string, any) error {
	return fmt.Errorf("unused")
}

func TestNestedURLTestFailoverAndFailback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	ctx, cancel := context.WithCancel(service.ContextWithDefaultRegistry(context.Background()))
	defer cancel()
	manager := &testManager{members: make(map[string]adapter.Outbound)}
	history := urltest.NewHistoryStorage()
	service.MustRegister[adapter.OutboundManager](ctx, manager)
	service.MustRegisterPtr(ctx, history)
	logger := log.NewNOPFactory().Logger()
	p1, p2, fin := proxy("spmk1", true), proxy("spmk2", true), proxy("fin1", true)
	p1.delay = 80 * time.Millisecond
	p2.delay = 100 * time.Millisecond // Faster fin must NOT win.
	for _, p := range []*testProxy{p1, p2, fin} {
		manager.members[p.Tag()] = p
	}
	for tag, members := range map[string][]string{"spmk": {"spmk1", "spmk2"}, "fin": {"fin1"}} {
		o, err := group.NewURLTest(ctx, nil, logger, tag, option.URLTestOutboundOptions{Outbounds: members, URL: server.URL})
		if err != nil {
			t.Fatal(err)
		}
		manager.members[tag] = o
		if err = o.(*group.URLTest).Start(adapter.StartStateStart, adapter.NewScope(ctx, logger)); err != nil {
			t.Fatal(err)
		}
	}
	out, err := newFallback(ctx, nil, logger, "vpn", FallbackOptions{Outbounds: []string{"spmk", "fin"}, URL: server.URL, RecoveryChecks: 2})
	if err != nil {
		t.Fatal(err)
	}
	f := out.(*fallback)
	defer f.Close()
	if err = f.Start(adapter.StartStateStart, adapter.NewScope(ctx, logger)); err != nil {
		t.Fatal(err)
	}
	// Invalidate timestamps between cycles: no sleeps or real remote servers.
	check := func(want string) {
		for _, p := range []*testProxy{p1, p2, fin} {
			history.DeleteURLTestHistory(p.Tag())
		}
		f.check()
		selected := f.Selected(N.NetworkTCP)
		if want == "" {
			if selected != nil {
				t.Fatalf("got %s, want unavailable", selected.Tag())
			}
			return
		}
		if selected == nil || selected.Tag() != want {
			t.Fatalf("selected %v, want %s", selected, want)
		}
	}
	check("spmk")
	p1.available.Store(false)
	check("spmk") // Other primary member still works.
	p2.available.Store(false)
	check("fin")
	p1.available.Store(true)
	check("fin")
	check("spmk")
	p1.available.Store(false)
	fin.available.Store(false)
	check("")
	fin.available.Store(true)
	check("fin")
}

func TestCanceledDialDoesNotWaitForInitialProbe(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := &fallback{ctx: context.Background(), ready: make(chan struct{})}
	if _, err := f.chosen(ctx, N.NetworkTCP); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
}

func TestFailbackKeepsExistingUserConnection(t *testing.T) {
	group := interrupt.NewGroup()
	local, remote := net.Pipe()
	defer remote.Close()
	conn := group.NewConn(local, true)
	defer conn.Close()
	group.Interrupt(false)
	done := make(chan error, 1)
	go func() { _, err := conn.Write([]byte{1}); done <- err }()
	_ = remote.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 1)
	if _, err := remote.Read(buf); err != nil {
		t.Fatal("existing connection interrupted:", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
