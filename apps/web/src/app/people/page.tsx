// Back-compat: /people now lives as the Players tab of the unified Directory.
import { redirect } from "next/navigation";

export default function PeoplePage() {
  redirect("/directory?tab=players");
}
