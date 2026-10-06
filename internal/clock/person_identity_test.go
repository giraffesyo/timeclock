package clock

import (
	"testing"

	"github.com/giraffesyo/timeclock/host"
)

func TestDirectoryIdentityAndManagerInheritance(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	hp := host.Person{ID: f.ada.ID, Name: f.ada.Name, Email: f.ada.Email, ManagerID: f.boss.ID, AvatarURL: "https://example.com/ada.png"}
	for _, avatar := range []string{hp.AvatarURL, hp.AvatarURL, "https://example.com/new.png", ""} {
		hp.AvatarURL = avatar
		actor, err := f.Sync(ctx, hp)
		if err != nil {
			t.Fatal(err)
		}
		if actor.AvatarURL != avatar || actor.ManagerID != f.boss.ID || actor.DirectoryManagerID != f.boss.ID || actor.ManagerOverrideID != "" {
			t.Fatalf("unexpected identity: %+v", actor)
		}
		people, err := f.People(ctx, f.admin)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range people {
			if p.ID == hp.ID && p.AvatarURL != avatar {
				t.Fatalf("list lost avatar: %+v", p)
			}
		}
	}
	updated, err := f.UpdatePerson(ctx, f.admin, hp.ID, PersonUpdate{PayrollID: "PAY-1", Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ManagerOverrideID != "" || updated.ManagerID != f.boss.ID {
		t.Fatalf("payroll edit changed manager: %+v", updated)
	}
	updated, err = f.UpdatePerson(ctx, f.admin, hp.ID, PersonUpdate{ManagerID: f.admin.ID, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ManagerID != f.admin.ID || updated.DirectoryManagerID != f.boss.ID || updated.ManagerOverrideID != f.admin.ID {
		t.Fatalf("override lost directory manager: %+v", updated)
	}
	hp.ManagerID = f.bob.ID
	actor, err := f.Sync(ctx, hp)
	if err != nil {
		t.Fatal(err)
	}
	if actor.ManagerID != f.admin.ID || actor.DirectoryManagerID != f.bob.ID {
		t.Fatalf("sync lost override: %+v", actor)
	}
	updated, err = f.UpdatePerson(ctx, f.admin, hp.ID, PersonUpdate{Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ManagerID != f.bob.ID {
		t.Fatalf("did not resolve directory manager: %+v", updated)
	}
}
