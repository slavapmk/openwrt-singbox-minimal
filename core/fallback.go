package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/common/interrupt"
	"github.com/sagernet/sing-box/common/urltest"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/protocol/group"
	"github.com/sagernet/sing/common/json/badoption"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

// FallbackOptions belongs to this minimal build, not upstream sing-box.
// The order of Outbounds is the priority order; RTT never compares tiers.
type FallbackOptions struct {
	Outbounds                 []string           `json:"outbounds"`
	URL                       string             `json:"url,omitempty"`
	Interval                  badoption.Duration `json:"interval,omitempty"`
	RecoveryChecks            int                `json:"recovery_checks,omitempty"`
	InterruptExistConnections bool               `json:"interrupt_exist_connections,omitempty"`
}

func registerFallback(registry *outbound.Registry) {
	outbound.Register[FallbackOptions](registry, "fallback", newFallback)
}

var _ adapter.OutboundGroup = (*fallback)(nil)
var _ adapter.Referrer = (*fallback)(nil)

// priorityState is mutated only under fallback.mu.
type priorityState struct {
	selected int
	success  []int
	recovery int
}

func (s *priorityState) update(alive []bool) int {
	for i, ok := range alive {
		if ok {
			if s.success[i] < s.recovery {
				s.success[i]++
			}
		} else {
			s.success[i] = 0
		}
	}
	current := s.selected
	// An unavailable selection fails over immediately; startup also takes the
	// first working tier without waiting for the recovery hysteresis.
	if current < 0 || !alive[current] {
		s.selected = -1
		for i, ok := range alive {
			if ok {
				s.selected = i
				break
			}
		}
	} else {
		for i := 0; i < current; i++ {
			if alive[i] && s.success[i] >= s.recovery {
				s.selected = i
				break
			}
		}
	}
	return s.selected
}

type fallback struct {
	outbound.Adapter
	ctx         context.Context
	cancel      context.CancelFunc
	manager     adapter.OutboundManager
	history     *urltest.HistoryStorage
	logger      log.ContextLogger
	options     FallbackOptions
	interval    time.Duration
	members     []adapter.Outbound
	mu          sync.RWMutex
	state       priorityState
	ready       chan struct{}
	done        chan struct{}
	started     bool
	connections *interrupt.Group
}

func newFallback(ctx context.Context, _ adapter.Router, logger log.ContextLogger, tag string, options FallbackOptions) (adapter.Outbound, error) {
	if len(options.Outbounds) == 0 {
		return nil, fmt.Errorf("fallback: missing outbounds")
	}
	seen := make(map[string]bool)
	for _, member := range options.Outbounds {
		if member == "" || member == tag || seen[member] {
			return nil, fmt.Errorf("fallback: invalid or duplicate outbound %q", member)
		}
		seen[member] = true
	}
	interval := time.Duration(options.Interval)
	if interval == 0 {
		interval = 30 * time.Second
	}
	if interval < time.Second {
		return nil, fmt.Errorf("fallback: interval must be at least 1s")
	}
	if options.RecoveryChecks == 0 {
		options.RecoveryChecks = 2
	}
	if options.RecoveryChecks < 1 || options.RecoveryChecks > 100 {
		return nil, fmt.Errorf("fallback: recovery_checks must be 1..100")
	}
	if options.URL == "" {
		options.URL = "https://www.gstatic.com/generate_204"
	}
	parsed, err := url.Parse(options.URL)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("fallback: url must be an HTTP/HTTPS URL")
	}
	ctx, cancel := context.WithCancel(ctx)
	return &fallback{
		Adapter: outbound.NewAdapter("fallback", tag, []string{N.NetworkTCP, N.NetworkUDP}, options.Outbounds),
		ctx:     ctx, cancel: cancel, manager: service.FromContext[adapter.OutboundManager](ctx),
		history: service.PtrFromContext[urltest.HistoryStorage](ctx), logger: logger,
		options: options, interval: interval,
		state: priorityState{selected: -1, success: make([]int, len(options.Outbounds)), recovery: options.RecoveryChecks},
		ready: make(chan struct{}), done: make(chan struct{}), connections: interrupt.NewGroup(),
	}, nil
}

func (f *fallback) Start(stage adapter.StartStage, scope *adapter.Scope) error {
	switch stage {
	case adapter.StartStateStart:
		if f.history == nil {
			return fmt.Errorf("fallback: missing URL test history")
		}
		for _, tag := range f.options.Outbounds {
			member, ok := f.manager.Outbound(tag)
			if !ok {
				return fmt.Errorf("fallback: outbound %q not found", tag)
			}
			f.members = append(f.members, member)
		}
	case adapter.StartStateStarted:
		f.started = true
		go f.loop()
		scope.Add(f.Close)
	}
	return nil
}

func (f *fallback) loop() {
	defer close(f.done)
	f.check()
	// A nested URLTest may still be performing its own initial probe. Retry
	// once shortly afterwards instead of leaving a working group unselected
	// for the full interval. Dialers wait for this first bounded initialization.
	if f.Selected(N.NetworkTCP) == nil && f.ctx.Err() == nil {
		timer := time.NewTimer(time.Second)
		select {
		case <-timer.C:
			f.check()
		case <-f.ctx.Done():
			timer.Stop()
		}
	}
	close(f.ready)
	ticker := time.NewTicker(f.interval)
	defer ticker.Stop()
	for {
		select {
		case <-f.ctx.Done():
			return
		case <-ticker.C:
			f.check()
		}
	}
}

func (f *fallback) check() {
	// Upstream recursively checks URLTest members and updates their selection.
	// Healthy cached results are reused until interval expires, avoiding a
	// second independent set of probes on a memory-constrained router.
	result := group.URLTestOutbounds(f.ctx, f.manager, f.history, f.logger, f.members, f.options.URL, f.interval, false)
	if f.ctx.Err() != nil {
		return
	}
	alive := make([]bool, len(f.members))
	for i, member := range f.members {
		_, alive[i] = result[member.Tag()]
		// A plain outbound may have been skipped because its successful history
		// is still fresh. Nested groups are represented by their chosen leaf.
		if !alive[i] {
			history := f.history.LoadURLTestHistory(group.RealTag(member, N.NetworkTCP))
			alive[i] = history != nil && time.Since(history.Time) <= f.interval
		}
	}
	f.mu.Lock()
	previous := f.state.selected
	next := f.state.update(alive)
	f.mu.Unlock()
	if previous != next {
		if next < 0 {
			f.logger.Warn("all fallback tiers unavailable")
		} else {
			f.logger.Info("selected fallback tier: ", f.members[next].Tag())
		}
		// Existing user connections are kept by default. New connections use
		// the newly selected tier without restarting the core or changing JSON.
		f.connections.Interrupt(f.options.InterruptExistConnections)
	}
}

func (f *fallback) All() []string { return f.options.Outbounds }
func (f *fallback) Selected(_ string) adapter.Outbound {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.state.selected < 0 {
		return nil
	}
	return f.members[f.state.selected]
}
func (f *fallback) References() []string {
	if selected := f.Selected(N.NetworkTCP); selected != nil {
		return []string{selected.Tag()}
	}
	return nil
}
func (f *fallback) AttachConnection(closer io.Closer) func() { return f.connections.Add(closer, true) }
func (f *fallback) chosen(ctx context.Context, network string) (adapter.Outbound, error) {
	select {
	case <-f.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
	member := f.Selected(network)
	if member == nil {
		return nil, fmt.Errorf("fallback: all tiers unavailable")
	}
	for _, supported := range member.Network() {
		if supported == network {
			return member, nil
		}
	}
	return nil, fmt.Errorf("fallback: selected tier does not support %s", network)
}
func (f *fallback) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	member, err := f.chosen(ctx, N.NetworkName(network))
	if err != nil {
		return nil, err
	}
	conn, err := member.DialContext(ctx, network, destination)
	if err != nil {
		return nil, err
	}
	return f.connections.NewConn(conn, interrupt.IsExternalConnectionFromContext(ctx)), nil
}
func (f *fallback) ListenPacket(ctx context.Context, destination M.Socksaddr) (net.PacketConn, error) {
	member, err := f.chosen(ctx, N.NetworkUDP)
	if err != nil {
		return nil, err
	}
	conn, err := member.ListenPacket(ctx, destination)
	if err != nil {
		return nil, err
	}
	return f.connections.NewPacketConn(conn, interrupt.IsExternalConnectionFromContext(ctx)), nil
}
func (f *fallback) Close() error {
	f.cancel()
	if f.started {
		<-f.done
	}
	f.connections.Interrupt(true)
	return nil
}
