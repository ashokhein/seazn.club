// QR self-check-in landing (PROMPT-53): scanned at the venue. Logged out →
// auth card with next back here; logged in → one tap to check in. The write
// happens on the button POST, never on this GET (link scanners and prefetch
// must not check anyone in). Unclaimed scanners get the claim-first
// interstitial, not an error.
import { getCurrentUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { verifyCheckinToken } from "@/server/usecases/checkin-token";
import { AuthForm } from "@/components/auth-form";
import { NightStage } from "@/components/night-stage";
import { CheckinAction } from "@/components/checkin-action";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function CheckinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const user = await getCurrentUser();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  let dead: string | null = null;
  try {
    await verifyCheckinToken(token);
  } catch (err) {
    dead = err instanceof HttpError ? err.message : "This check-in code is not valid";
  }

  return (
    <NightStage maxW="max-w-md">
      <DictProvider dict={ui} locale={locale}>
      {dead ? (
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-purple-900">{t(ui, "checkin.title")}</h1>
          <p className="mt-2 text-sm text-slate-500">{dead}</p>
        </div>
      ) : (
        <>
          <div className="mb-6 text-center">
            <h1 className="app-display text-3xl font-bold tracking-tight text-cream">
              {t(ui, "checkin.title")}
            </h1>
            <p className="mt-2 text-sm text-cream/70">
              {t(ui, "checkin.subtitle")}
            </p>
          </div>
          {user ? (
            <div className="card p-6">
              <CheckinAction token={token} />
            </div>
          ) : (
            <>
              <p className="mb-4 text-center text-sm text-cream/70">
                {t(ui, "checkin.signInPrompt")}
              </p>
              <AuthForm next={`/checkin/${token}`} />
            </>
          )}
        </>
      )}
      </DictProvider>
    </NightStage>
  );
}
