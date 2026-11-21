import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals, static files and the agent door (/agent/mcp
    // authenticates with a Quiqup platform token, not Clerk).
    "/((?!_next|agent/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always include API/tRPC + well-known
    "/(api|trpc|.well-known)(.*)",
  ],
};
