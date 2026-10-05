package clock

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Audit history belongs to the recorded time and is retained on disconnect.
// Rebuild operational links on reconnect, including entries since deleted in
// either app, so absence is reviewed and independently edited time is not copied.
func restoreTogglLinks(ctx context.Context, q querier, workspace int64) error {
	rows, err := q.Query(ctx, `SELECT DISTINCT ON (a.detail->>'entryId') a.detail,a.person_id,p.person_id
 FROM audit_log a JOIN toggl_people p ON p.workspace_id=a.workspace_id AND p.remote_user::text=a.detail->>'remoteUser'
 WHERE a.workspace_id=$W AND a.action IN ('toggl.pull','toggl.push','toggl.link')
 AND a.detail->>'remoteWorkspace'=$1
 ORDER BY a.detail->>'entryId',a.at DESC,a.id DESC`, fmt.Sprint(workspace))
	if err != nil {
		return err
	}
	type recorded struct {
		Detail   []byte
		Original string
		Person   string
	}
	previous, err := pgx.CollectRows(rows, pgx.RowToStructByPos[recorded])
	if err != nil {
		return err
	}
	for _, r := range previous {
		if r.Original != r.Person {
			return invalidField("people", "match previously imported Toggl users to their original Timeclock people")
		}
		var detail struct {
			EntryID  uuid.UUID  `json:"entryId"`
			RemoteID int64      `json:"remoteId"`
			After    togglState `json:"after"`
		}
		if err := json.Unmarshal(r.Detail, &detail); err != nil {
			return err
		}
		if detail.RemoteID <= 0 || detail.EntryID == uuid.Nil {
			continue
		}
		_, err = q.Exec(ctx, `INSERT INTO toggl_entries(workspace_id,entry_id,person_id,remote_id,baseline,remote)
 VALUES($W,$1,$2,$3,$4,$4) ON CONFLICT(workspace_id,entry_id) DO NOTHING`, detail.EntryID, r.Person, detail.RemoteID, stateJSON(detail.After))
		if err != nil {
			return err
		}
	}
	// Catalog identity also survives local renames and remote ordering changes.
	_, err = q.Exec(ctx, `INSERT INTO toggl_projects(workspace_id,remote_id,project_id)
 SELECT DISTINCT ON (a.detail->>'remoteId') $W,(a.detail->>'remoteId')::bigint,p.id
 FROM audit_log a JOIN projects p ON p.workspace_id=a.workspace_id AND p.id::text=a.detail->>'projectId'
 WHERE a.workspace_id=$W AND a.action='toggl.project' AND a.detail->>'remoteWorkspace'=$1
 ORDER BY a.detail->>'remoteId',a.at DESC,a.id DESC
 ON CONFLICT(workspace_id,remote_id) DO NOTHING`, fmt.Sprint(workspace))
	return err
}
