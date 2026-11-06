package main

import (
 "context"
 "flag"
 "fmt"
 "os"
 "os/signal"
 "runtime"
 "syscall"

 box "github.com/sagernet/sing-box"
 "github.com/sagernet/sing-box/adapter/certificate"
 "github.com/sagernet/sing-box/adapter/endpoint"
 "github.com/sagernet/sing-box/adapter/inbound"
 "github.com/sagernet/sing-box/adapter/outbound"
 "github.com/sagernet/sing-box/adapter/service"
 "github.com/sagernet/sing-box/dns"
 "github.com/sagernet/sing-box/dns/transport"
 "github.com/sagernet/sing-box/dns/transport/local"
 "github.com/sagernet/sing-box/option"
 "github.com/sagernet/sing-box/protocol/direct"
 "github.com/sagernet/sing-box/protocol/group"
 "github.com/sagernet/sing-box/protocol/hysteria2"
 "github.com/sagernet/sing-box/protocol/mixed"
 "github.com/sagernet/sing-box/protocol/redirect"
 "github.com/sagernet/sing/common/json"
 svc "github.com/sagernet/sing/service"
)

func run() error {
 command := "run"
 args:=os.Args[1:]
 if len(args)>0 {command=args[0];args=args[1:]}
 if command=="version" {fmt.Println("sing-box 1.14.4 minimal HY2/SNI",runtime.GOOS,runtime.GOARCH);return nil}
 if command!="run" && command!="check" {return fmt.Errorf("usage: sing-box-min run|check -c config.json | version")}
 flags:=flag.NewFlagSet(command,flag.ContinueOnError)
 path:=flags.String("c","config.json","configuration")
 if err:=flags.Parse(args);err!=nil{return err}
 in:=inbound.NewRegistry()
 mixed.RegisterInbound(in)
 redirect.RegisterTProxy(in)
 redirect.RegisterRedirect(in)
 out:=outbound.NewRegistry()
 direct.RegisterOutbound(out)
 hysteria2.RegisterOutbound(out)
 group.RegisterSelector(out)
 group.RegisterURLTest(out)
 dn:=dns.NewTransportRegistry()
 transport.RegisterUDP(dn)
 transport.RegisterTCP(dn)
 transport.RegisterTLS(dn)
 transport.RegisterHTTPS(dn)
 local.RegisterTransport(dn)
 ctx,cancel:=context.WithCancel(svc.ExtendContext(context.Background()))
 defer cancel()
 ctx=box.Context(ctx,in,out,endpoint.NewRegistry(),dn,service.NewRegistry(),certificate.NewRegistry())
 data,err:=os.ReadFile(*path)
 if err!=nil{return err}
 options,err:=json.UnmarshalExtendedContext[option.Options](ctx,data)
 if err!=nil{return err}
 instance,err:=box.New(box.Options{Context:ctx,Options:options})
 if err!=nil{return err}
 if command=="check" {return instance.Close()}
 if err=instance.Start();err!=nil{instance.Close();return err}
 signals:=make(chan os.Signal,1)
 signal.Notify(signals,os.Interrupt,syscall.SIGTERM)
 <-signals
 signal.Stop(signals)
 return instance.Close()
}
func main(){if err:=run();err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}}
