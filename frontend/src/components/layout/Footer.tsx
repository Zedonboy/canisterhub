/** Shared footer for the project-agnostic pages (Dashboard, Marketplace,
 * Account, and the product/template detail pages) - these are
 * `min-h-screen flex flex-col` layouts with a `flex-1 main`, so this sits
 * flush at the bottom whether the page's own content is short or tall.
 * `/project/:id/*` pages (`AppShell`'s Sidebar+Header) deliberately don't
 * get one - that's a dense, viewport-filling tool surface, not a page
 * with a natural bottom. Links are the same placeholder `#` hrefs
 * `Login.tsx`'s own mini-footer already used - nothing real to point them
 * at yet. */
export function Footer() {
  return (
    <footer className="border-t border-[#1e2d47] px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-[#4a5568] flex-shrink-0">
      <span>© {new Date().getFullYear()} Canisterhub</span>
      <div className="flex items-center gap-3">
        <a href="#" className="hover:text-[#8892a4] transition-colors">Docs</a>
        <span className="text-[#1e2d47]">·</span>
        <a href="#" className="hover:text-[#8892a4] transition-colors">Status</a>
        <span className="text-[#1e2d47]">·</span>
        <a href="#" className="hover:text-[#8892a4] transition-colors">Privacy</a>
      </div>
    </footer>
  );
}
