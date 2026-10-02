import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Wordlex — Word Puzzle" },
      {
        name: "description",
        content:
          "A five-letter word puzzle: daily and unlimited puzzles offline, plus online team matches.",
      },
      { property: "og:title", content: "Wordlex" },
      {
        property: "og:description",
        content: "Daily word, unlimited puzzles and team matches with friends.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  // The game itself is a self-contained static site in /public/wordle/.
  // We redirect from the React shell so opening the project root just plays.
  useEffect(() => {
    window.location.replace("/wordle/index.html");
  }, []);
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui",
      }}
    >
      <a href="/wordle/index.html">Open Wordlex →</a>
    </div>
  );
}
