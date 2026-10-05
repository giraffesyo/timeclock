//go:build e2e

package clock

import "time"

// The same Hopper worker and durable schedule, polled faster in browser tests.
const togglPollInterval = time.Second
