import { useMemo, useState } from "react";
import { TopNav } from "@/components/layout/TopNav";
import { Footer } from "@/components/layout/Footer";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { CanisterID } from "@/components/CanisterID";
import { ToastProvider, toast } from "@/components/Toast";
import {
  generateSeedPhrase, isValidSeedPhrase, identityFromSeedPhrase,
} from "@/lib/publisherIdentity";
import { connectGithubRepo } from "@/lib/githubConnect";
import type { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { KeyRound, Sparkles, ClipboardPaste, Copy, Check, TriangleAlert, Github, Loader2 } from "lucide-react";

type Mode = "generate" | "add" | null;

/** `/market/publisher` - sets up the real identity a marketplace publisher's
 * own CI uses to call `backend::publish_marketplace_item` (see `lib/publisherIdentity.ts`'s
 * own doc comment for the full shape of this). Nothing here is mock: the
 * seed phrase is a real BIP-39 mnemonic generated in the browser, the
 * principal is the real one that phrase derives, and "Connect Git" opens a
 * real GitHub OAuth consent screen (see `lib/githubConnect.ts`) - only once
 * GitHub's own API confirms you administer the repo does the orchestrator
 * (a controller of `backend`) call `register_repo_publisher` on this
 * dashboard's behalf, binding the separate generated CI principal to it.
 * `publish_marketplace_item` later checks its caller against that recorded
 * publisher principal. */
export default function PublisherSetup() {
  const [mode, setMode] = useState<Mode>(null);
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [pastedPhrase, setPastedPhrase] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copiedPhrase, setCopiedPhrase] = useState(false);
  const [savedPhrase, setSavedPhrase] = useState(false);

  const [repoUrl, setRepoUrl] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);

  const identity: Ed25519KeyIdentity | null = useMemo(() => {
    if (!seedPhrase || !isValidSeedPhrase(seedPhrase)) return null;
    try {
      return identityFromSeedPhrase(seedPhrase);
    } catch {
      return null;
    }
  }, [seedPhrase]);

  const principal = identity?.getPrincipal().toText() ?? null;

  const startGenerate = () => {
    setMode("generate");
    setSeedPhrase(generateSeedPhrase());
    setRevealed(false);
    setSavedPhrase(false);
    setRegistered(null);
  };

  const startAdd = () => {
    setMode("add");
    setSeedPhrase(null);
    setPastedPhrase("");
    setSavedPhrase(false);
    setRegistered(null);
  };

  const confirmPasted = () => {
    const trimmed = pastedPhrase.trim().toLowerCase();
    if (!isValidSeedPhrase(trimmed)) {
      toast.error("Not a valid seed phrase", "Check the 24 words and try again.");
      return;
    }
    setSeedPhrase(trimmed);
    setRevealed(true);
  };

  const copyPhrase = async () => {
    if (!seedPhrase) return;
    await navigator.clipboard.writeText(seedPhrase);
    setCopiedPhrase(true);
    setTimeout(() => setCopiedPhrase(false), 1500);
  };

  const submitRepo = async () => {
    if (!identity || !repoUrl.trim()) return;
    setRegistering(true);
    try {
      const result = await connectGithubRepo(identity.getPrincipal(), repoUrl.trim());
      if (!result.success) {
        toast.error("Couldn't connect this repo", result.error ?? "GitHub did not confirm admin access.");
        return;
      }
      setRegistered(result.repoUrl);
      toast.success("Repo connected", "This identity can now publish marketplace items under it.");
    } catch (e) {
      toast.error("Couldn't connect this repo", e instanceof Error ? e.message : String(e));
    } finally {
      setRegistering(false);
    }
  };

  const words = seedPhrase?.split(" ") ?? [];

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <TopNav active="marketplace" />

      <main className="flex-1 px-4 sm:px-6 py-10 max-w-2xl mx-auto w-full space-y-6">
        <div>
          <h1 className="text-xl font-bold text-[#e2e8f0] flex items-center gap-2">
            <KeyRound size={20} className="text-[#00d4ff]" /> Publisher Identity
          </h1>
          <p className="text-sm text-[#4a5568] mt-1">
            Set up the identity your CI uses to publish real packages to the marketplace - a real ICP principal,
            derived from a seed phrase you control, registered against the GitHub repo <code className="text-[#8892a4]">publish_marketplace_item</code> will
            check it against.
          </p>
        </div>

        {mode === null && (
          <Card>
            <CardContent className="space-y-3">
              <Button variant="primary" className="w-full justify-center gap-1.5" onClick={startGenerate}>
                <Sparkles size={14} /> Generate a new identity
              </Button>
              <Button variant="secondary" className="w-full justify-center gap-1.5" onClick={startAdd}>
                <ClipboardPaste size={14} /> I already have a seed phrase
              </Button>
            </CardContent>
          </Card>
        )}

        {mode === "add" && !identity && (
          <Card>
            <CardHeader><CardTitle>Enter your seed phrase</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <textarea
                value={pastedPhrase}
                onChange={(e) => setPastedPhrase(e.target.value)}
                placeholder="24 words, separated by spaces"
                rows={3}
                className="w-full px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0] placeholder-[#4a5568] font-mono outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] transition-colors resize-none"
              />
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setMode(null)}>Back</Button>
                <Button variant="primary" size="sm" onClick={confirmPasted} disabled={!pastedPhrase.trim()}>Continue</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {seedPhrase && mode === "generate" && (
          <Card>
            <CardHeader><CardTitle>Your seed phrase</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-[#ffab40] bg-[#ffab400d] border border-[#ffab4033] rounded-lg px-3 py-2 flex items-start gap-2">
                <TriangleAlert size={14} className="flex-shrink-0 mt-0.5" />
                This is generated locally in your browser and never sent anywhere. Anyone with these 24 words can
                publish packages as this identity - save it somewhere private now. It will not be shown again after
                you leave this page.
              </p>

              {!revealed ? (
                <Button variant="secondary" className="w-full justify-center" onClick={() => setRevealed(true)}>
                  Click to reveal
                </Button>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-[#0a0e1a] border border-[#1e2d47] rounded-lg">
                    {words.map((word, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs font-mono">
                        <span className="text-[#4a5568] w-4 text-right">{i + 1}.</span>
                        <span className="text-[#e2e8f0]">{word}</span>
                      </div>
                    ))}
                  </div>
                  <Button variant="secondary" size="sm" className="gap-1.5" onClick={copyPhrase}>
                    {copiedPhrase ? <Check size={13} className="text-[#00e676]" /> : <Copy size={13} />}
                    {copiedPhrase ? "Copied" : "Copy phrase"}
                  </Button>
                  <label className="flex items-start gap-2 text-xs text-[#8892a4] cursor-pointer">
                    <input type="checkbox" checked={savedPhrase} onChange={(e) => setSavedPhrase(e.target.checked)} className="mt-0.5" />
                    I've saved this phrase somewhere private
                  </label>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {identity && principal && (mode === "add" || savedPhrase) && (
          <>
            <Card>
              <CardHeader><CardTitle>Publisher principal</CardTitle></CardHeader>
              <CardContent>
                <CanisterID id={principal} showFull className="text-sm" />
                <p className="text-xs text-[#4a5568] mt-2">
                  Store your seed phrase as a secret in your GitHub repo (e.g. <code className="text-[#8892a4]">PUBLISHER_SEED_PHRASE</code>).
                  Your CI reconstructs this exact identity from it - the first 32 bytes of the phrase's BIP-39 seed,
                  fed to an Ed25519 keypair - and calls <code className="text-[#8892a4]">publish_marketplace_item</code> with it after
                  building and uploading a GitHub Release.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Connect a repo</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label htmlFor="repo-url">GitHub repository URL</Label>
                  <Input
                    id="repo-url"
                    placeholder="https://github.com/your-org/your-package"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    disabled={registering}
                    className="font-mono text-xs"
                  />
                </div>
                <p className="text-[11px] text-[#4a5568]">
                  Opens GitHub to confirm you have admin access to this repository. Only after GitHub itself verifies
                  that does the CI principal shown above get registered against it - that's the only principal{" "}
                  <code className="text-[#8892a4]">publish_marketplace_item</code> will accept for this repository afterwards.
                </p>
                <Button variant="primary" size="sm" className="gap-1.5" onClick={submitRepo} disabled={registering || !repoUrl.trim()}>
                  {registering ? <Loader2 size={13} className="animate-spin" /> : <Github size={13} />}
                  {registering ? "Connecting…" : "Connect Git"}
                </Button>

                {registered && (
                  <p className="text-xs text-[#00e676] bg-[#00e67611] border border-[#00e67644] rounded-lg px-3 py-2">
                    Connected. Your CI can now call <code className="text-[#8892a4]">publish_marketplace_item</code> for{" "}
                    <span className="font-mono">{registered}</span> as the registered CI principal.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>

      <Footer />
      <ToastProvider />
    </div>
  );
}
