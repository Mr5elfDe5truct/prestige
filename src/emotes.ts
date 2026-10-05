// Emote reactions, both ways: you react to Prestige's replies (the smiley beside a reply), and Prestige reacts to
// your messages by starting a reply with a tag like [react: 😂], which is taken out of the text and shown as a
// reaction on your message instead. The model hears about your reaction in its next turn.
// Switched off in Settings → Appearance (body.no-emotes hides them, and the model isn't offered the tag).

export const EMOTES = ["👍", "❤️", "😂", "😮", "🔥", "🎩"];

export const REACT_HINT =
  "You can react to the user's latest message with a single emoji, like a reaction in a chat app, by starting your reply " +
  "with a tag such as [react: 😂]. Only do it now and then, when the message really calls for it (something funny, kind, " +
  "exciting or impressive); most replies have no reaction. The tag is shown as a reaction, so don't mention it in your reply.";

/** A line for the system prompt when the user reacted to the previous reply. */
export const reactedNote = (emoji: string) => `The user reacted ${emoji} to your previous reply.`;

const TAG = /^\s*\[react:\s*([^\]\s][^\]]{0,15}?)\s*\]\s*/i;
const TAG_ANYWHERE = /\[react:\s*[^\]]{1,16}\]\s*/gi;

/** Holds back the start of a streamed reply until it's clear whether it opens with a [react: …] tag, then passes
 *  the text on without the tag. */
export function reactFilter(emit: (text: string) => void, onReact: (emoji: string) => void) {
  let held = "";
  let decided = false;
  const decide = (final: boolean) => {
    const m = TAG.exec(held);
    if (m) {
      decided = true;
      onReact(m[1].trim());
      const rest = held.slice(m[0].length);
      held = "";
      if (rest) emit(rest);
      return;
    }
    const t = held.trimStart();
    // Still possibly a tag: "[", "[re", "[react: 😂" with no "]" yet (and not too long to be one).
    const maybe = t === "" || ("[react:".startsWith(t.toLowerCase().slice(0, 7)) && t.length < 26 && !t.includes("]"));
    if (maybe && !final) return;
    decided = true;
    const out = held;
    held = "";
    if (out) emit(out);
  };
  return {
    push(text: string) {
      if (decided) return emit(text);
      held += text;
      decide(false);
    },
    /** The reply ended: let go of anything still held. */
    flush() {
      if (!decided) decide(true);
    },
  };
}

/** Removes a tag that turned up somewhere other than the start. */
export const stripTags = (text: string) => (text.includes("[react:") || text.includes("[React:") ? text.replace(TAG_ANYWHERE, "") : text);

/** Shows (or clears) the reaction on a message bubble. `pop` animates it in, with a little burst. */
export function showReaction(bubble: HTMLElement, emoji: string | undefined, pop = false) {
  let badge = bubble.querySelector<HTMLElement>(":scope > .react-badge");
  if (!emoji) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "react-badge";
    bubble.appendChild(badge);
  }
  badge.textContent = emoji;
  badge.title = bubble.classList.contains("you") ? "Prestige reacted" : "Your reaction (click the smiley to change it)";
  if (pop) {
    badge.classList.remove("pop");
    void badge.offsetWidth; // restart the animation
    badge.classList.add("pop");
    burst(badge, emoji);
  }
}

/** A few copies of the emoji float up and fade from `from`. */
export function burst(from: HTMLElement, emoji: string) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = from.getBoundingClientRect();
  for (let i = 0; i < 6; i++) {
    const s = document.createElement("span");
    s.className = "emote-float";
    s.textContent = emoji;
    s.style.left = `${r.left + r.width / 2}px`;
    s.style.top = `${r.top + r.height / 2}px`;
    s.style.setProperty("--dx", `${(Math.random() - 0.5) * 90}px`);
    s.style.setProperty("--dy", `${-50 - Math.random() * 70}px`);
    s.style.setProperty("--rot", `${(Math.random() - 0.5) * 50}deg`);
    s.style.animationDelay = `${i * 45}ms`;
    document.body.appendChild(s);
    s.addEventListener("animationend", () => s.remove());
  }
}

let open: HTMLElement | null = null;

/** The emote picker beside a reply's smiley button; picking the current one again takes it back. */
export function pickReaction(anchor: HTMLElement, current: string | undefined, onPick: (emoji: string | undefined) => void) {
  closePicker();
  const pop = document.createElement("div");
  pop.className = "emote-pick";
  pop.setAttribute("role", "menu");
  for (const e of EMOTES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.setAttribute("role", "menuitem");
    b.className = e === current ? "on" : "";
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closePicker();
      onPick(e === current ? undefined : e);
    });
    pop.appendChild(b);
  }
  anchor.parentElement!.appendChild(pop);
  open = pop;
  setTimeout(() => document.addEventListener("click", closePicker, { once: true }));
}

function closePicker() {
  open?.remove();
  open = null;
}
