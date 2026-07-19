import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NewsTab } from "@/components/news/news-tab";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { OrgPost } from "@/server/usecases/org-posts";

// NewsTab calls useRouter() for post-mutation refreshes; static render has no
// app router, so stub it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const dict = uiEn as unknown as Dict;
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      {node}
    </DictProvider>,
  );

function post(overrides: Partial<OrgPost>): OrgPost {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    orgId: "00000000-0000-0000-0000-0000000000aa",
    competitionId: null,
    divisionId: null,
    kind: "announcement",
    status: "published",
    slug: "hello",
    title: "Hello",
    bodyMd: "Body",
    heroImagePath: null,
    autoSource: null,
    publishedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const base = { orgId: "o", orgSlug: "org", competitions: [], canEdit: true };

describe("NewsTab archived disclosure", () => {
  it("folds archived posts into an Archived (N) details with republish + delete", () => {
    const html = wrap(
      <NewsTab
        {...base}
        posts={[
          post({ id: "p1", slug: "live", title: "Live post" }),
          post({ id: "p2", slug: "old", title: "Old post", status: "archived" }),
        ]}
      />,
    );
    expect(html).toContain('data-testid="news-archived"');
    expect(html).toContain("Archived (1)");
    expect(html).toContain('data-testid="archived-republish"');
    expect(html).toContain("Republish");
    // The archived post renders once, in its own row — not as a published row.
    expect(html.match(/data-testid="archived-row"/g)).toHaveLength(1);
    expect(html.match(/data-testid="published-row"/g)).toHaveLength(1);
    expect(html).toContain("Old post");
  });

  it("hides the section entirely when nothing is archived", () => {
    const html = wrap(<NewsTab {...base} posts={[post({})]} />);
    expect(html).not.toContain('data-testid="news-archived"');
  });

  it("read-only members see archived posts without actions", () => {
    const html = wrap(
      <NewsTab {...base} canEdit={false} posts={[post({ status: "archived" })]} />,
    );
    expect(html).toContain('data-testid="news-archived"');
    expect(html).not.toContain('data-testid="archived-republish"');
  });
});
