import type { Metadata } from "next";
import { SetupWizard } from "@/features/onboarding/SetupWizard";

export const metadata: Metadata = { title: "Set up · HealthAccess" };
export const instant = false;

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <SetupWizard nextPath={Array.isArray(next) ? next[0] : next} />;
}
