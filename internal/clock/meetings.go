package clock

import (
	"context"
	"fmt"

	"github.com/google/uuid"
)

// MeetingChoice is the project a person copies a meeting to: nil for none.
type MeetingChoice struct {
	ProjectID *uuid.UUID
}

// Meetings are the projects the actor copies these meetings to, for those
// they have chosen one for. A project archived since is no choice: the
// next copy asks again.
func (s *Service) Meetings(ctx context.Context, actor Actor, meetings []string) (map[string]MeetingChoice, error) {
	out := map[string]MeetingChoice{}
	if len(meetings) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT m.meeting, m.project_id FROM calendar_meetings m
		LEFT JOIN projects p ON p.id = m.project_id
		LEFT JOIN customers c ON c.id = p.customer_id
		WHERE m.workspace_id = $W AND m.person_id = $1 AND m.meeting = ANY($2)
		  AND (m.project_id IS NULL OR (p.archived_at IS NULL AND c.archived_at IS NULL))`, actor.ID, meetings)
	if err != nil {
		return nil, fmt.Errorf("read meetings: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var meeting string
		var project *uuid.UUID
		if err := rows.Scan(&meeting, &project); err != nil {
			return nil, fmt.Errorf("read meetings: %w", err)
		}
		out[meeting] = MeetingChoice{ProjectID: project}
	}
	return out, rows.Err()
}

// RememberMeeting keeps the project the actor copies a meeting to.
func (s *Service) RememberMeeting(ctx context.Context, actor Actor, meeting string, projectID *uuid.UUID) error {
	if meeting == "" || len(meeting) > 1024 {
		return invalidField("meeting", "must be a meeting from your calendar")
	}
	cfg, err := s.Settings(ctx)
	if err != nil {
		return err
	}
	if err := checkProject(ctx, s.pool, cfg, projectID); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO calendar_meetings (workspace_id, person_id, meeting, project_id)
		VALUES ($W, $1, $2, $3)
		ON CONFLICT (workspace_id, person_id, meeting) DO UPDATE SET project_id = EXCLUDED.project_id, updated_at = now()`,
		actor.ID, meeting, projectID); err != nil {
		return fmt.Errorf("remember a meeting: %w", err)
	}
	return nil
}
