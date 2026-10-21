import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Store, Boxes, KeyRound } from "lucide-react";
import { clsx } from "clsx";
import { Badge } from "@/components/ui/Badge";
import { ToastProvider } from "@/components/Toast";
import { CommandPalette } from "@/components/CommandPalette";
import { ProductSearch } from "@/components/ProductSearch";
import { TopNav } from "@/components/layout/TopNav";
import { Footer } from "@/components/layout/Footer";
import { listProducts, type Product } from "@/lib/products";
import { listTemplates, type TemplateSummary } from "@/lib/templates";

export default function Marketplace() {
  const navigate = useNavigate();
  const [activeTag, setActiveTag] = useState("All");
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  useEffect(() => {
    let active = true;
    listProducts().then((value) => active && setProducts(value)).catch(() => active && setProducts([]));
    listTemplates().then((value) => active && setTemplates(value)).catch(() => active && setTemplates([]));
    return () => { active = false; };
  }, []);

  const tags = useMemo(() => ["All", ...Array.from(new Set(products.map((p) => p.tag)))], [products]);
  const popular = products.filter((p) => p.popular);
  const filtered = activeTag === "All" ? products : products.filter((p) => p.tag === activeTag);

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <TopNav active="marketplace" />

      <main className="flex-1 px-4 sm:px-6 py-6 max-w-7xl mx-auto w-full">
        <div className="py-12 flex flex-col items-center text-center animate-fade-in">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#c084fc11] border border-[#c084fc33] text-[10px] text-[#c084fc] font-mono mb-4">
            <Store size={11} />
            {products.length} canister products available
          </div>
          <h1 className="text-3xl font-bold text-[#e2e8f0] mb-2">Marketplace</h1>
          <p className="text-sm text-[#4a5568] mb-8">
            Browse pre-built canister products and install them into any project in seconds
          </p>
          <ProductSearch />
          <button
            onClick={() => navigate("/market/publisher")}
            className="flex items-center gap-1.5 text-xs text-[#4a5568] hover:text-[#00d4ff] transition-colors mt-4"
          >
            <KeyRound size={12} />
            Publish your own package
          </button>
        </div>

        <div className="mb-10">
          <div className="flex items-center justify-between mb-4"><div><h2 className="text-base font-semibold text-[#e2e8f0]">Project Templates</h2><p className="text-xs text-[#4a5568] mt-1">Complete, pre-configured application architectures</p></div><Badge variant="gray">{templates.length} templates</Badge></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{templates.map((template) => <button key={template.id} onClick={() => navigate(`/templates/${template.id}`)} className="text-left p-4 rounded-xl border border-[#c084fc33] bg-[#c084fc08] hover:-translate-y-0.5 transition-all group">
            <div className="flex items-center justify-between mb-3"><div className="w-10 h-10 rounded-lg bg-[#c084fc18] border border-[#c084fc33] flex items-center justify-center"><Boxes size={17} className="text-[#c084fc]"/></div><Badge variant="gray">{template.package_count} packages</Badge></div>
            <h3 className="text-sm font-semibold group-hover:text-[#c084fc]">{template.name}</h3><p className="text-xs text-[#8892a4] mt-1 line-clamp-2">{template.description}</p><div className="text-[10px] text-[#4a5568] mt-3">{template.category} · v{template.version} · {template.download_count.toLocaleString()} downloads</div>
          </button>)}</div>
        </div>

        {popular.length > 0 && (
          <div className="mb-8">
            <h2 className="text-base font-semibold text-[#e2e8f0] mb-4">Popular this week</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {popular.map((product) => (
                <button
                  key={product.id}
                  onClick={() => navigate(`/market/product/${product.id}`)}
                  className="text-left p-4 rounded-xl border bg-[#0d1526] hover:-translate-y-0.5 transition-all duration-150 group"
                  style={{ borderColor: product.borderColor }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ color: product.color, backgroundColor: product.bgColor, border: `1px solid ${product.borderColor}` }}
                    >
                      {product.icon()}
                    </div>
                    <Badge variant="cyan">Popular</Badge>
                  </div>
                  <div className="text-sm font-semibold text-[#e2e8f0] group-hover:text-[#00d4ff] transition-colors">{product.name}</div>
                  <div className="text-xs text-[#8892a4] mt-1 leading-relaxed">{product.tagline}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-[#e2e8f0]">All Products</h2>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-5">
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={clsx(
                "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                activeTag === tag
                  ? "bg-[#00d4ff] text-[#0a0e1a] border-[#00d4ff]"
                  : "bg-[#0f1629] text-[#8892a4] border-[#1e2d47] hover:border-[#00d4ff44] hover:text-[#e2e8f0]"
              )}
            >
              {tag}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((product) => (
            <div
              key={product.id}
              className="rounded-xl border border-[#1e2d47] bg-[#0f1629] hover:border-[#00d4ff33] transition-colors group animate-fade-in flex flex-col"
            >
              <div className="p-4 flex-1 space-y-3">
                <div className="flex items-start justify-between">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center"
                    style={{ color: product.color, backgroundColor: product.bgColor, border: `1px solid ${product.borderColor}` }}
                  >
                    {product.icon()}
                  </div>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-md border font-mono flex-shrink-0"
                    style={{ color: product.color, borderColor: product.borderColor, backgroundColor: product.bgColor }}
                  >
                    {product.cycleCost}
                  </span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[#e2e8f0] group-hover:text-[#00d4ff] transition-colors">
                      {product.name}
                    </h3>
                    <Badge variant="gray">{product.tag}</Badge>
                  </div>
                  <p className="text-xs text-[#8892a4] mt-1.5 leading-relaxed line-clamp-2">{product.description}</p>
                  <p className="text-[10px] text-[#4a5568] mt-2">{product.downloadCount.toLocaleString()} downloads</p>
                </div>
              </div>
              <button
                onClick={() => navigate(`/market/product/${product.id}`)}
                className="flex items-center justify-center gap-1.5 py-2.5 text-xs text-[#8892a4] hover:text-[#00d4ff] hover:bg-[#00d4ff08] border-t border-[#1e2d47] transition-colors rounded-b-xl"
              >
                View product <ArrowRight size={11} />
              </button>
            </div>
          ))}
        </div>
      </main>

      <Footer />

      <ToastProvider />
      <CommandPalette />
    </div>
  );
}
