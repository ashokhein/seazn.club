import type { Metadata } from "next";
import { ScalarReference } from "./scalar-client";

export const metadata: Metadata = {
  title: "API reference",
  description:
    "The published seazn.club API: key-scoped operations plus the open public read API, with schemas, examples and a try-it console.",
};

export default function ReferencePage() {
  return <ScalarReference />;
}
