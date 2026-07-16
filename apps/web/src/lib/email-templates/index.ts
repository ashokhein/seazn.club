// Email templates — one file per email type. Each exports a builder returning
// { subject, html, text }; the send path in lib/email.ts stays transport-only.
export { verificationTemplate } from "./verification";
export { passwordResetTemplate } from "./password-reset";
export { magicLinkTemplate } from "./magic-link";
export { emailChangeConfirmTemplate } from "./email-change-confirm";
export { emailChangeNoticeTemplate } from "./email-change-notice";
export { accountDeletionTemplate } from "./account-deletion";
export { inviteTemplate } from "./invite";
export { registrationTemplate, type RegistrationEmailArgs } from "./registration";
export { paymentReminderTemplate, type PaymentReminderArgs } from "./payment-reminder";
export {
  registrationPromotedTemplate,
  type RegistrationPromotedArgs,
} from "./registration-promoted";
export { refundIssuedTemplate, type RefundIssuedArgs } from "./refund-issued";
export { disputeAlertTemplate, type DisputeAlertArgs } from "./dispute-alert";
export { disputeLostTemplate, type DisputeLostArgs } from "./dispute-lost";
export { funnelClaimTemplate, funnelReminderTemplate, type FunnelEmailArgs } from "./funnel";
export { claimInviteTemplate, type ClaimInviteArgs } from "./claim-invite";
export { sponsorInvoiceTemplate, type SponsorInvoiceArgs } from "./sponsor-invoice";
export { sponsorReceiptTemplate, type SponsorReceiptArgs } from "./sponsor-receipt";
