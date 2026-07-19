// Post OG card (SPEC-2): every WhatsApp/iMessage/X preview of a news link
// becomes a branded mini-scorebug. Next hashes this route — the post page links
// it via generated metadata (the file-based convention injects the meta tag), so
// nothing hardcodes the path (v3 lesson).
import { ImageResponse } from "next/og";
import { getPublicOrg } from "@/server/public-site/data";
import { publicPost } from "@/server/usecases/org-posts";
import { HttpError } from "@/lib/errors";
import { postCardModel, PostShareCard, OG_SIZE } from "@/server/og/post-card";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale, DEFAULT_LOCALE } from "@/lib/i18n-constants";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

type Props = { params: Promise<{ orgSlug: string; postSlug: string }> };

export default async function Image({ params }: Props) {
  const { orgSlug, postSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) return new Response("not found", { status: 404 });
  const org = data.org;
  let post;
  try {
    post = await publicPost(orgSlug, postSlug);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return new Response("not found", { status: 404 });
    }
    throw err;
  }
  const locale = hasLocale(org.default_locale) ? org.default_locale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale, "public");
  const model = postCardModel({
    branding: [org.branding],
    branded: org.branded,
    orgName: org.name,
    logo: org.logo,
    kind: post.kind,
    title: post.title,
  });
  return new ImageResponse(
    <PostShareCard model={model} eyebrow={t(dict, model.eyebrowKey)} size="og" />,
    size,
  );
}
