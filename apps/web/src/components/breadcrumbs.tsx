"use client";
// Breadcrumb trail + universal back button for the /o console (v3/01 §3–4).
// Fully derived from route params — zero per-page wiring. The org layout
// supplies display names for every slug under the org.
import { useParams } from "next/navigation";

export interface BreadcrumbNameMap {
  /** compSlug → competition name */
  comps: Record<string, string>;
  /** `${compSlug}/${divSlug}` → division name */
  divs: Record<string, string>;
}

interface BreadcrumbsProps {
  orgName: string;
  orgs: { name: string; slug: string }[];
  names: BreadcrumbNameMap;
}

export function Breadcrumbs(props: BreadcrumbsProps) {
  const params = useParams<{ orgSlug: string; compSlug?: string; divSlug?: string }>();
  // Placeholder until PROMPT-30 task 7 lands the full trail + back button.
  void props;
  void params;
  return null;
}
