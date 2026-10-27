// Suspense boundary for every page: the root layout's boundary covers the first
// load, but on client navigations only the page segment re-renders and needs its
// own fallback while request-time data (session, database) streams in.
export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-3">
      <div className="h-8 w-56 animate-pulse rounded bg-line" />
      <div className="h-40 animate-pulse rounded-xl bg-line/60" />
    </div>
  );
}
