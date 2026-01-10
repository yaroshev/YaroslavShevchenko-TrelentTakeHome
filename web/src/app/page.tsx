import { RunWizard } from "@/components/run-wizard";

export default function Home() {
  return (
    <main className="min-h-screen bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            Conventor by Trelent -Convert documents into clean HTML guides
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Upload, convert, download.
          </p>
        </div>
        <RunWizard />
      </div>
    </main>
  );
}
