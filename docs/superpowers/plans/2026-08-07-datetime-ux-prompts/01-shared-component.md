# Prompt 01: Shared `DateTimeField` component

**Context**: `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`,
decision 1 — native inputs, componentized, no custom picker. The reason:
native `<input type="time">` structurally cannot shade a blacked-out
range inline regardless of componentization, so there's no partial
version of a custom picker worth building for that reason alone, and
nothing else in scope needs one.

**Acceptance criteria**: one component, three `kind` variants, styled
identically to the existing division-wizard inputs (the "consistent
inputs" reference this repo already uses), mobile-safe
(`text-base sm:text-sm` so iOS doesn't zoom on focus).

**Do not touch**: any of the six existing call sites yet — this prompt
only builds the component. Converting call sites is Prompts 02-04.

**Files:**
- Create: `apps/web/src/components/v2/shared/datetime-field.tsx`
- Test: `apps/web/src/components/v2/shared/__tests__/datetime-field.test.tsx`

**Interfaces:**
- Produces: `<DateTimeField kind="date" | "time" | "datetime-local" value={string} onChange={(v: string) => void} label={string} min?={string} disabled?={boolean} />` — Prompts 02, 03, 04, 06 all import this exact shape.

- [ ] **Step 1: Read the reference styling**

Read `apps/web/src/components/v2/division-builder.tsx` lines 760-790
(its native date/time inputs) to copy the exact current class names and
structure.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/src/components/v2/shared/__tests__/datetime-field.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateTimeField } from "../datetime-field.tsx";

describe("DateTimeField", () => {
  it("renders a native input of the requested kind with the shared input class", () => {
    render(<DateTimeField kind="date" value="2026-08-07" onChange={() => {}} label="Start date" />);
    const input = screen.getByLabelText("Start date");
    expect(input).toHaveAttribute("type", "date");
    expect(input.className).toContain("input");
  });

  it("uses text-base sm:text-sm so iOS does not zoom on focus", () => {
    render(<DateTimeField kind="time" value="09:00" onChange={() => {}} label="Start time" />);
    expect(screen.getByLabelText("Start time").className).toMatch(/text-base/);
  });

  it("calls onChange with the raw input value", () => {
    const onChange = vi.fn();
    render(<DateTimeField kind="datetime-local" value="" onChange={onChange} label="Kickoff" />);
    fireEvent.change(screen.getByLabelText("Kickoff"), { target: { value: "2026-08-07T09:00" } });
    expect(onChange).toHaveBeenCalledWith("2026-08-07T09:00");
  });

  it("applies min when provided", () => {
    render(<DateTimeField kind="date" value="" onChange={() => {}} label="End date" min="2026-08-07" />);
    expect(screen.getByLabelText("End date")).toHaveAttribute("min", "2026-08-07");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/shared/__tests__/datetime-field.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 4: Write the component**

```typescript
// apps/web/src/components/v2/shared/datetime-field.tsx
"use client";

import { useId } from "react";

export interface DateTimeFieldProps {
  kind: "date" | "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  label: string;
  min?: string;
  disabled?: boolean;
}

export function DateTimeField({ kind, value, onChange, label, min, disabled }: DateTimeFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        type={kind}
        className="input w-full text-base sm:text-sm"
        value={value}
        min={min}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/shared/__tests__/datetime-field.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/shared/datetime-field.tsx apps/web/src/components/v2/shared/__tests__/datetime-field.test.tsx
git commit -m "feat(web): shared DateTimeField component, consolidating six ad-hoc native inputs"
```

**Verify**: `cd apps/web && npx vitest run src/components/v2/shared/__tests__/datetime-field.test.tsx` → 4 passed, 0 failed.

**Output cap**: final message under 15 lines — pass count, confirm class names match the division-wizard reference exactly.
