package clock

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"

	"github.com/giraffesyo/timeclock/host"
)

// The theme types are the host's, so a host can hand Timeclock its own look
// in the same shape an admin sets one.
type (
	// Theme is a look for light and for dark.
	Theme = host.Theme
	// Scheme is one of the two: the page's seed, and optionally the sidebar's.
	Scheme = host.Scheme
	// ThemeSeed is the few values a whole scheme is derived from.
	ThemeSeed = host.ThemeSeed
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func checkSeed(field string, s *ThemeSeed) error {
	if s == nil {
		return nil
	}
	if !hexColor.MatchString(s.Accent) {
		return invalidField(field+".accent", "must be a color like #4b50d9")
	}
	if !hexColor.MatchString(s.Background) {
		return invalidField(field+".background", "must be a color like #ffffff")
	}
	if s.Contrast != 0 && (s.Contrast < 0.5 || s.Contrast > 1.5) {
		return invalidField(field+".contrast", "must be between 0.5 and 1.5")
	}
	return nil
}

func checkTheme(t Theme) error {
	for name, scheme := range map[string]*Scheme{"light": t.Light, "dark": t.Dark} {
		if scheme == nil {
			continue
		}
		if err := checkSeed(name+".interface", &scheme.Interface); err != nil {
			return err
		}
		if err := checkSeed(name+".sidebar", scheme.Sidebar); err != nil {
			return err
		}
	}
	return nil
}

// Theme returns the look an admin set for the workspace; its schemes are nil
// where they set none.
func (s *Service) Theme(ctx context.Context) (Theme, error) {
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT theme FROM settings`).Scan(&raw); err != nil {
		return Theme{}, fmt.Errorf("read theme: %w", err)
	}
	var t Theme
	if err := json.Unmarshal(raw, &t); err != nil {
		return Theme{}, fmt.Errorf("read theme: %w", err)
	}
	return t, nil
}

// SetTheme sets the workspace's look. An empty theme goes back to the
// host's, or Timeclock's own.
func (s *Service) SetTheme(ctx context.Context, actor Actor, t Theme) (Theme, error) {
	if !actor.Admin {
		return Theme{}, forbidden("only an admin changes the theme")
	}
	if err := checkTheme(t); err != nil {
		return Theme{}, err
	}
	raw, err := json.Marshal(t)
	if err != nil {
		return Theme{}, fmt.Errorf("set theme: %w", err)
	}
	err = s.tx(ctx, "", func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE settings SET theme = $1, updated_at = now(), updated_by = $2`, raw, actor.ID); err != nil {
			return fmt.Errorf("set theme: %w", err)
		}
		return audit(ctx, tx, actor, "theme.update", "", t)
	})
	return t, err
}
