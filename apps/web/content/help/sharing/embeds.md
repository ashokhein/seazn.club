---
title: Embeds for your website
description: Paste one snippet into your club site — live standings, schedule or bracket, always current.
order: 4
---

Pro orgs can **embed** live standings, a schedule or a bracket into any website — WordPress, Squarespace, a hand-written club page.

## Get the snippet

Open the division's **Settings tab → Sharing & embed**, pick what to embed, and copy the snippet. It's a single iframe:

```
<iframe src="https://seazn.club/embed/divisions/…/standings"
        style="width:100%;border:0" loading="lazy"></iframe>
```

Paste it wherever your site accepts HTML. The widget sizes its own height and keeps itself up to date — you never touch it again.

## What it respects

- **Visibility** — embeds of private divisions show nothing; link-only ones work.
- **Youth privacy** — shortened names, same as the dashboard.
- **Your branding** — the widget carries your accent colour.

## Common questions

**Why is my embed empty?** The division's competition is Private — switch it to Link only or Public.

**Does it slow my site?** It lazy-loads and weighs less than most images.
