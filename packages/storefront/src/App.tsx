import { useEffect, useState } from "react";
import { LogOut, ShoppingCart, Store } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/Button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useCart } from "@/lib/cart";
import { useCustomerAuth } from "@/lib/customerAuth";
import { useEmbedHeight } from "@/lib/embed";
import { EMBED, navigate, useRoute } from "@/lib/router";
import { useCatalog } from "@/lib/useCatalog";
import { storefrontBranding } from "@/lib/canisterId";
import Cart from "@/pages/Cart";
import Catalog from "@/pages/Catalog";
import ItemDetail from "@/pages/ItemDetail";
import Orders from "@/pages/Orders";

function BrandMark({ logoUrl }: { logoUrl: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [logoUrl]);

  if (logoUrl && !imageFailed) {
    return (
      <img
        src={logoUrl}
        alt=""
        className="w-full h-full rounded-lg object-contain"
        referrerPolicy="no-referrer"
        onError={() => setImageFailed(true)}
      />
    );
  }
  return <Store size={16} className="text-c-accent" />;
}

export default function App() {
  const route = useRoute();
  const auth = useCustomerAuth();
  const catalog = useCatalog();
  const lines = useCart();
  const branding = storefrontBranding();
  useEmbedHeight();

  const cartCount = Object.values(lines).reduce((a, b) => a + b, 0);
  const nav = (page: string, label: string, to: string) => (
    <button
      onClick={() => navigate(to)}
      className={clsx(
        "px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors",
        route.page === page || (page === "catalog" && route.page === "item") ? "bg-c-accent-a14 text-c-accent" : "text-c-muted hover:text-c-text",
      )}
    >
      {label}
    </button>
  );

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-c-line bg-c-bg/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2 sm:gap-4">
          <button onClick={() => navigate("/")} className="flex items-center gap-2 min-w-0 mr-1" aria-label="Store home">
            <span className="w-8 h-8 rounded-lg bg-c-accent-a14 border border-c-accent-a44 flex items-center justify-center shrink-0">
              <BrandMark logoUrl={branding.logoUrl} />
            </span>
            <span className="font-semibold truncate">{branding.businessName ?? catalog.business?.name ?? "Store"}</span>
          </button>
          <nav className="flex items-center">{nav("catalog", "Shop", "/")}{nav("orders", "My orders", "/orders")}</nav>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="hidden sm:block"><ThemeToggle /></div>
            <Button variant="secondary" size="sm" onClick={() => navigate("/cart")} aria-label={`Cart, ${cartCount} items`} className="relative">
              <ShoppingCart size={15} />
              {cartCount > 0 && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-c-accent text-c-on-accent text-[10px] font-bold flex items-center justify-center">{cartCount}</span>}
            </Button>
            {auth.status === "authenticated" && (
              <Button variant="ghost" size="sm" onClick={() => void auth.signOut()} title={`Sign out (${auth.principal?.slice(0, 5)}…)`} aria-label="Sign out">
                <LogOut size={15} />
              </Button>
            )}
            {auth.status === "anonymous" && (
              <Button variant="outline" size="sm" onClick={() => void auth.signIn().catch(() => undefined)}>Sign in</Button>
            )}
          </div>
        </div>
      </header>

      <main className={clsx("flex-1 w-full max-w-6xl mx-auto px-4", EMBED ? "py-4" : "py-6")}>
        {(route.page === "catalog" || route.page === "item") && (
          <Catalog items={catalog.items} loading={catalog.loading} error={catalog.error} reload={catalog.reload} />
        )}
        {route.page === "cart" && <Cart items={catalog.items} loading={catalog.loading} auth={auth} onOrdered={catalog.reload} />}
        {route.page === "orders" && <Orders auth={auth} placed={route.placed} onChanged={catalog.reload} />}
        {route.page === "item" && <ItemDetail item={catalog.items.find((i) => i.id === route.id)} loading={catalog.loading} />}
      </main>

      {!EMBED && (
        <footer className="border-t border-c-line py-4 px-4 text-center text-xs text-c-faint flex items-center justify-center gap-3">
          <span>Sign-in by Internet Identity</span>
          <span className="sm:hidden"><ThemeToggle /></span>
        </footer>
      )}
    </>
  );
}
