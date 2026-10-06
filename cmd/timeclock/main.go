// Command timeclock talks to a Timeclock server.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/giraffesyo/timeclock/internal/cli"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := cli.New(version).ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
