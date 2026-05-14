import React from "react";
import ReactDOM from "react-dom/client";
import { PetWindow } from "./PetWindow";
import { SettingsWindow } from "./SettingsWindow";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "pet";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view === "settings" ? <SettingsWindow /> : <PetWindow />}</React.StrictMode>,
);
