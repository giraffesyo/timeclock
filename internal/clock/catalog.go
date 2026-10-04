package clock

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func isUniqueViolation(err error) bool {
	pgErr, ok := errors.AsType[*pgconn.PgError](err)
	return ok && pgErr.Code == "23505"
}

func isForeignKeyViolation(err error) bool {
	pgErr, ok := errors.AsType[*pgconn.PgError](err)
	return ok && pgErr.Code == "23503"
}

// --- Customers ---

func scanCustomer(row pgx.Row) (Customer, error) {
	var c Customer
	err := row.Scan(&c.ID, &c.Name, &c.Archived)
	return c, err
}

// Customers lists customers by name, with archived ones when asked.
func (s *Service) Customers(ctx context.Context, archived bool) ([]Customer, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, archived_at IS NOT NULL FROM customers
		WHERE workspace_id = $W AND ($1 OR archived_at IS NULL) ORDER BY lower(name)`, archived)
	if err != nil {
		return nil, fmt.Errorf("list customers: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Customer, error) { return scanCustomer(row) })
	if err != nil {
		return nil, fmt.Errorf("list customers: %w", err)
	}
	return out, nil
}

// SaveCustomer creates a customer, or with an id renames or archives one.
func (s *Service) SaveCustomer(ctx context.Context, actor Actor, id uuid.UUID, name string, archived bool) (Customer, error) {
	if !actor.Admin {
		return Customer{}, forbidden("only an admin changes customers")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return Customer{}, requiredField("name")
	}
	var out Customer
	err := s.tx(ctx, "", func(tx querier) error {
		var err error
		if id == uuid.Nil {
			out, err = scanCustomer(tx.QueryRow(ctx,
				`INSERT INTO customers (id, workspace_id, name) VALUES ($1, $W, $2) RETURNING id, name, archived_at IS NOT NULL`, newID(), name))
		} else {
			out, err = scanCustomer(tx.QueryRow(ctx, `UPDATE customers SET name = $2,
				archived_at = CASE WHEN $3 THEN coalesce(archived_at, now()) END
				WHERE id = $1 AND workspace_id = $W RETURNING id, name, archived_at IS NOT NULL`, id, name, archived))
		}
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return notFound("customer")
		case isUniqueViolation(err):
			return ErrNameTaken.New("a customer already has this name")
		case err != nil:
			return fmt.Errorf("save customer: %w", err)
		}
		return audit(ctx, tx, actor, "customer.save", "", out)
	})
	return out, err
}

// DeleteCustomer removes a customer with no projects.
func (s *Service) DeleteCustomer(ctx context.Context, actor Actor, id uuid.UUID) error {
	if !actor.Admin {
		return forbidden("only an admin changes customers")
	}
	return s.tx(ctx, "", func(tx querier) error {
		tag, err := tx.Exec(ctx, `DELETE FROM customers WHERE id = $1 AND workspace_id = $W`, id)
		switch {
		case isForeignKeyViolation(err):
			return ErrInUse.New("the customer has projects")
		case err != nil:
			return fmt.Errorf("delete customer: %w", err)
		case tag.RowsAffected() == 0:
			return notFound("customer")
		}
		return audit(ctx, tx, actor, "customer.delete", "", map[string]any{"id": id})
	})
}

// --- Projects ---

const projectSelect = `SELECT p.id, p.customer_id, c.name, p.name, p.code, p.billable,
	p.archived_at IS NOT NULL, c.archived_at IS NOT NULL
	FROM projects p LEFT JOIN customers c ON c.id = p.customer_id`

func scanProject(row pgx.Row) (Project, error) {
	var p Project
	var customer *string
	var customerArchived *bool
	err := row.Scan(&p.ID, &p.CustomerID, &customer, &p.Name, &p.Code, &p.Billable, &p.Archived, &customerArchived)
	if customer != nil {
		p.CustomerName, p.CustomerArchived = *customer, *customerArchived
	}
	return p, err
}

// Projects lists internal projects, then the rest by customer, each by name,
// with archived ones when asked: its own, and those of archived customers.
func (s *Service) Projects(ctx context.Context, archived bool) ([]Project, error) {
	rows, err := s.pool.Query(ctx, projectSelect+`
		WHERE p.workspace_id = $W AND ($1 OR (p.archived_at IS NULL AND c.archived_at IS NULL)) ORDER BY lower(coalesce(c.name, '')), lower(p.name)`, archived)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Project, error) { return scanProject(row) })
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	return out, nil
}

// ProjectInput is what an admin sets on a project.
type ProjectInput struct {
	CustomerID *uuid.UUID `json:"customerId,omitempty" doc:"Absent for internal work."`
	Name       string     `json:"name" minLength:"1" maxLength:"120"`
	Code       string     `json:"code,omitempty" maxLength:"64" doc:"A charge code or contract number."`
	Billable   bool       `json:"billable"`
	Archived   bool       `json:"archived,omitempty"`
}

// SaveProject creates a project, or with an id changes one.
func (s *Service) SaveProject(ctx context.Context, actor Actor, id uuid.UUID, in ProjectInput) (Project, error) {
	if !actor.Admin {
		return Project{}, forbidden("only an admin changes projects")
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return Project{}, requiredField("name")
	}
	var out Project
	err := s.tx(ctx, "", func(tx querier) error {
		var err error
		if in.CustomerID != nil {
			// The customer is this workspace's, or it is no customer at all.
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1 AND workspace_id = $W)`, in.CustomerID).Scan(&ok); err != nil {
				return fmt.Errorf("check customer: %w", err)
			}
			if !ok {
				return invalidField("customerId", "no such customer")
			}
		}
		if id == uuid.Nil {
			id = newID()
			_, err = tx.Exec(ctx, `INSERT INTO projects (id, workspace_id, customer_id, name, code, billable) VALUES ($1, $W, $2, $3, $4, $5)`,
				id, in.CustomerID, in.Name, strings.TrimSpace(in.Code), in.Billable)
		} else {
			var tag pgconn.CommandTag
			tag, err = tx.Exec(ctx, `UPDATE projects SET customer_id = $2, name = $3, code = $4, billable = $5,
				archived_at = CASE WHEN $6 THEN coalesce(archived_at, now()) END WHERE id = $1 AND workspace_id = $W`,
				id, in.CustomerID, in.Name, strings.TrimSpace(in.Code), in.Billable, in.Archived)
			if err == nil && tag.RowsAffected() == 0 {
				return notFound("project")
			}
		}
		switch {
		case isUniqueViolation(err):
			return ErrNameTaken.New("there is already a project with this name")
		case isForeignKeyViolation(err):
			return invalidField("customerId", "no such customer")
		case err != nil:
			return fmt.Errorf("save project: %w", err)
		}
		if out, err = scanProject(tx.QueryRow(ctx, projectSelect+` WHERE p.id = $1 AND p.workspace_id = $W`, id)); err != nil {
			return fmt.Errorf("read project: %w", err)
		}
		return audit(ctx, tx, actor, "project.save", "", out)
	})
	return out, err
}

// DeleteProject removes a project no time was recorded on.
func (s *Service) DeleteProject(ctx context.Context, actor Actor, id uuid.UUID) error {
	if !actor.Admin {
		return forbidden("only an admin changes projects")
	}
	return s.tx(ctx, "", func(tx querier) error {
		tag, err := tx.Exec(ctx, `DELETE FROM projects WHERE id = $1 AND workspace_id = $W`, id)
		switch {
		case isForeignKeyViolation(err):
			return ErrInUse.New("the project has time recorded")
		case err != nil:
			return fmt.Errorf("delete project: %w", err)
		case tag.RowsAffected() == 0:
			return notFound("project")
		}
		return audit(ctx, tx, actor, "project.delete", "", map[string]any{"id": id})
	})
}

// usableProject checks a project can take new time: it exists and neither
// it nor its customer is archived.
func usableProject(ctx context.Context, q querier, id uuid.UUID) error {
	p, err := scanProject(q.QueryRow(ctx, projectSelect+` WHERE p.id = $1 AND p.workspace_id = $W`, id))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return invalidField("projectId", "no such project")
	case err != nil:
		return fmt.Errorf("read project: %w", err)
	case p.Archived || p.CustomerArchived:
		return ErrProjectArchived.New("")
	}
	return nil
}
