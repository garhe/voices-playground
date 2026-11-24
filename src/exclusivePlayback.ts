type Playable = { paused: boolean; pause(): void };
type PlaybackRoot = {
  addEventListener(type: 'play', listener: (event: { target: unknown }) => void, capture: boolean): void;
  removeEventListener(type: 'play', listener: (event: { target: unknown }) => void, capture: boolean): void;
  querySelectorAll(selectors: string): Iterable<Playable>;
};

/** Pauses every other audio/video element when one starts playing. Returns an uninstall function. */
export function installExclusivePlayback(root: PlaybackRoot): () => void {
  // Media events don't bubble, so a capture-phase listener is needed to observe them at the root.
  const onPlay = (event: { target: unknown }) => {
    for (const media of root.querySelectorAll('audio, video')) {
      if (media !== event.target && !media.paused) media.pause();
    }
  };
  root.addEventListener('play', onPlay, true);
  return () => root.removeEventListener('play', onPlay, true);
}
