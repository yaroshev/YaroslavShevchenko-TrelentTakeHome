import { readRunState } from "@/server/run-store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const state = await readRunState(runId);
    if (state.status === "completed") {
      return Response.json({
        status: "completed",
        progress: 100,
        downloadUrl: `/api/runs/${encodeURIComponent(runId)}/download`,
        current: state.current,
      });
    }
    if (state.status === "failed") {
      const isProd = process.env.NODE_ENV === "production";
      return Response.json({
        status: "failed",
        progress: state.progress ?? 0,
        error: state.error,
        ...(isProd ? null : { debugError: state.debugError }),
        current: state.current,
      });
    }
    return Response.json({
      status: state.status,
      progress: state.progress ?? 0,
      message: state.message,
      current: state.current,
    });
  } catch (e) {
    return Response.json(
      { status: "failed", progress: 0, error: e instanceof Error ? e.message : "Not found" },
      { status: 404 }
    );
  }
}

