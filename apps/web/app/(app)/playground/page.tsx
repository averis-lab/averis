import type { Metadata } from "next";
import { Playground } from "@/components/playground/playground";

export const metadata: Metadata = {
  title: "Playground — Averis",
  description: "Call the Intelligence API from the browser and copy the equivalent curl or SDK call.",
};

export default function PlaygroundPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Playground</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Call the gateway from here and copy the same request as curl or SDK code. Requests go
          through a server-side proxy that attaches the API key, so the key never reaches the
          browser — which is also why the endpoint list is fixed rather than a free-form URL field.
        </p>
      </header>
      <Playground />
    </div>
  );
}
