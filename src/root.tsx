import { component$ } from "@builder.io/qwik";
import { QwikCityProvider, RouterOutlet } from "@builder.io/qwik-city";
import { RouterHead } from "./components/router-head/router-head";
import "./global.css";

export default component$(() => (
  <QwikCityProvider>
    <head>
      <meta charset="utf-8" />
      <link rel="icon" href="data:," />
      <RouterHead />
    </head>
    <body>
      <RouterOutlet />
    </body>
  </QwikCityProvider>
));
