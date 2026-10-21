import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToastProvider } from "@/components/Toast";
import { Footer } from "@/components/layout/Footer";
import { ProductSearch } from "@/components/ProductSearch";
import { InstallProductDialog } from "@/components/InstallProductDialog";
import { getProduct, type Product } from "@/lib/products";

export default function ProductInstall() {
  const params = useParams();
  const navigate = useNavigate();
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [product, setProduct] = useState<Product | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const id = params.product_id;
    if (!id) {
      setProduct(null);
      return;
    }
    setProduct(undefined);
    getProduct(id)
      .then((value) => active && setProduct(value))
      .catch(() => active && setProduct(null));
    return () => { active = false; };
  }, [params.product_id]);

  if (product === undefined) {
    return <div className="min-h-screen bg-[#0a0e1a]" />;
  }

  if (!product) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">404</div>
          <div className="text-[#4a5568] mb-6">Product not found</div>
          <Button variant="secondary" onClick={() => navigate("/marketplace")}>
            Back to Marketplace
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <header className="h-12 flex items-center px-6 border-b border-[#1e2d47] bg-[#0a0e1a] flex-shrink-0">
        <button
          onClick={() => navigate("/marketplace")}
          className="flex items-center gap-2 text-[#4a5568] hover:text-[#e2e8f0] transition-colors text-sm"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="flex items-center gap-2 ml-4 pl-4 border-l border-[#1e2d47]">
          <div className="w-5 h-5 bg-[#00d4ff] rounded flex items-center justify-center">
            <Zap size={10} className="text-[#0a0e1a]" fill="currentColor" />
          </div>
          <span className="text-sm font-semibold text-[#e2e8f0]">
            Canisterhub
          </span>
          <span className="text-[#4a5568]">/</span>
          <span className="text-sm text-[#8892a4]">Products</span>
          <span className="text-[#4a5568]">/</span>
          <span className="text-sm text-[#e2e8f0]">{product.name}</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10 space-y-10">
        <div className="flex items-start justify-between gap-6 animate-fade-in">
          <div className="flex items-start gap-6">
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{
                color: product.color,
                background: product.bgColor,
                border: `1px solid ${product.borderColor}`,
                boxShadow: `0 0 32px ${product.color}20`,
              }}
            >
              <span style={{ transform: "scale(1.6)", display: "flex" }}>
                {product.icon()}
              </span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold text-[#e2e8f0]">
                  {product.name}
                </h1>
                <span
                  className="text-xs px-2 py-1 rounded-lg border font-mono"
                  style={{
                    color: product.color,
                    borderColor: product.color + "44",
                    backgroundColor: product.color + "11",
                  }}
                >
                  {product.cycleCost}
                </span>
              </div>
              <p className="text-[#8892a4] text-sm">{product.tagline}</p>
            </div>
          </div>
          <Button
            variant="primary"
            className="gap-1.5 flex-shrink-0"
            onClick={() => setShowInstallDialog(true)}
          >
            <Zap size={14} fill="currentColor" />
            Install
          </Button>
        </div>

        <div
          className="p-5 rounded-xl border border-[#1e2d47] bg-[#0d1526] animate-fade-in"
          style={{ animationDelay: "50ms" }}
        >
          <h2 className="text-xs font-semibold text-[#4a5568] uppercase tracking-widest mb-2">
            Description
          </h2>
          <p className="text-sm text-[#6b7c93] leading-relaxed max-w-2xl">
            {product.description}
          </p>
        </div>

        <div
          className="p-5 rounded-xl border border-[#1e2d47] bg-[#0d1526] animate-fade-in"
          style={{ animationDelay: "100ms" }}
        >
          <h2 className="text-xs font-semibold text-[#4a5568] uppercase tracking-widest mb-4">
            What's included
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {product.features.map((feature) => (
              <div key={feature} className="flex items-center gap-2.5">
                <CheckCircle2
                  size={14}
                  className="flex-shrink-0"
                  style={{ color: product.color }}
                />
                <span className="text-sm text-[#8892a4]">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <div
          className="animate-fade-in"
          style={{ animationDelay: "150ms" }}
        >
          <h2 className="text-sm font-semibold text-[#e2e8f0] mb-4">
            Browse other products
          </h2>
          <ProductSearch />
        </div>
      </main>

      <Footer />

      <InstallProductDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        product={product}
      />
      <ToastProvider />
    </div>
  );
}
