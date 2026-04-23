import { SiteSurface } from "@/components/site-surface";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <SiteSurface />
    </main>
  );
}
