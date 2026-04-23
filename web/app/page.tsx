import { cookies } from "next/headers";
import { MagicBar } from "@/components/magic-bar";
import { SiteSurface } from "@/components/site-surface";
import { hasAccessSession } from "@/lib/access-session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const initialAccessGranted = hasAccessSession(cookieStore);

  return (
    <main className="flex flex-1 flex-col">
      <SiteSurface />
      <MagicBar initialAccessGranted={initialAccessGranted} />
    </main>
  );
}
