import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initStoreEvents } from "./store";
import "./index.css";

initStoreEvents();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
