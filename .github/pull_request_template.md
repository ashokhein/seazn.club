## What

<!-- one-paragraph summary of the change -->

## Checklist

- [ ] Regression test added/extended that fails without this change
- [ ] `scripts/smoke.ts` exercises the feature on the pro AND free paths (new features)
- [ ] UX change → its `/help` article under `apps/web/content/help/**` is updated (v3/11 gap 14)
- [ ] `npm run openapi:gen` committed if any v1 route/schema changed (CI drift gate)
- [ ] `tsc` + unit tests green locally before push
