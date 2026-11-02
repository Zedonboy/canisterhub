import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import Inbox from "./Inbox";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Inbox />
  </StrictMode>,
);
