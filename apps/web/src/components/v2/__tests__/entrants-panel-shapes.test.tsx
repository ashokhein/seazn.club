import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NewEntrantFields, RosterEditor } from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel, EntrantKind } from "@seazn/engine/sport";

// Same harness as stages-panel-delete.test.tsx: mock the router + confirm hooks
// and assert on the STATIC markup. RosterEditor + NewEntrantFields are rendered
// in isolation, so only their own imports need stubbing.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const PERSONS = [
  { id: "p1", full_name: "Alice", dob: null, gender: null },
  { id: "p2", full_name: "Bob", dob: null, gender: null },
  { id: "p3", full_name: "Carol", dob: null, gender: null },
];

function member(id: string, name: string) {
  return {
    person_id: id,
    full_name: name,
    squad_number: null,
    default_position_key: null,
    is_captain: false,
    roles: [],
  };
}

function model(kind: EntrantKind): EffectiveEntrantModel {
  return {
    kinds: ["individual", "pair", "team"],
    defaultKind: kind,
    squadNumbers: true,
    captain: true,
    maxTeamMembers: null,
  };
}

function renderRoster(opts: {
  kind: string;
  members: ReturnType<typeof member>[];
  allowCaptain: boolean;
  allowSquadNumbers: boolean;
}) {
  return renderToStaticMarkup(
    <RosterEditor
      kind={opts.kind}
      members={opts.members}
      persons={PERSONS}
      positionGroups={[]}
      roles={[]}
      canEdit={true}
      busy={false}
      allowCaptain={opts.allowCaptain}
      allowSquadNumbers={opts.allowSquadNumbers}
      entrantModel={model(opts.kind as EntrantKind)}
      conflictsFor={() => []}
      onSave={() => {}}
    />,
  );
}

function renderAddForm(m: { kinds: EntrantKind[]; defaultKind: EntrantKind }) {
  const em: EffectiveEntrantModel = {
    kinds: m.kinds,
    defaultKind: m.defaultKind,
    squadNumbers: true,
    captain: true,
    maxTeamMembers: null,
  };
  return renderToStaticMarkup(
    <NewEntrantFields
      persons={PERSONS}
      busy={false}
      onSubmit={async () => undefined}
      entrantModel={em}
    />,
  );
}

describe("RosterEditor — kind/model-aware roster", () => {
  it("individual roster: no captain, no squad number, no picker at cap", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice")],
      allowCaptain: true,
      allowSquadNumbers: true,
    });
    expect(html).not.toContain("captain");
    expect(html).not.toContain('placeholder="No."');
    expect(html).not.toContain("Find player…");
  });

  it("team roster with captain disabled by config hides the checkbox", () => {
    const html = renderRoster({
      kind: "team",
      members: [member("p1", "Alice")],
      allowCaptain: false,
      allowSquadNumbers: false,
    });
    expect(html).not.toContain("captain");
    expect(html).toContain("Find player…");
  });

  it("pair picker caps at 2 — a full pair hides the add picker", () => {
    const html = renderRoster({
      kind: "pair",
      members: [member("p1", "Alice"), member("p2", "Bob")],
      allowCaptain: false,
      allowSquadNumbers: false,
    });
    expect(html).not.toContain("Find player…");
  });
});

describe("NewEntrantFields — kind/model-aware add form", () => {
  it("single allowed kind hides the select; individual keeps a name field (name-only entrants stay possible)", () => {
    const html = renderAddForm({ kinds: ["individual"], defaultKind: "individual" });
    expect(html).not.toContain(">Kind<");
    // The journeys regression (e2e serial): organisers register name-only
    // entrants without person records — the field must stay, auto-filled
    // when a person IS picked.
    expect(html).toContain(">Name<");
    expect(html).toContain('placeholder="Alex Doe"');
    expect(html).toContain("Search players…");
  });

  it("single allowed kind renders a static caption for that kind", () => {
    const html = renderAddForm({ kinds: ["individual"], defaultKind: "individual" });
    expect(html).toContain("Individual");
  });

  it("multiple kinds render the kind chip group", () => {
    const html = renderAddForm({
      kinds: ["individual", "pair", "team"],
      defaultKind: "team",
    });
    expect(html).toContain(">Kind<");
    // team default keeps the manual name field
    expect(html).toContain(">Name<");
  });
});
