import React, { useEffect, useMemo, useRef, useState } from "react";
import { generateId } from "@/lib/uuid";
import Cookies from "js-cookie";
import { useRouter } from "next/router";
import Player from "@/components/Player";
import QuizGuessPicker from "@/components/QuizGuessPicker";
import SiteShell from "@/components/SiteShell";
import { Button } from "@/components/ui/8bit/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/8bit/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/8bit/select";
import { Spinner } from "@/components/ui/8bit/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle2, Music2, UserX, Vote, X, XCircle } from "lucide-react";
import { getPlaylist, getPlaylistId, getSongsFromPlaylist, playTrackUri } from "@/lib/spotify";
import { buildQuizCatalog, getUniqueArtists } from "@/lib/quizCatalog";
import { verifyArtistGuess, verifySongGuess } from "@/lib/guessVerifier";
import {
  addActivity,
  allPlayersReady,
  applyClaim,
  applyWrongGuess,
  createPlayer,
  createRound,
  createSession,
  getActivePlayers,
  getRoundReadyPlayers,
  isRoundComplete,
  markPlayerKicked,
  markPlayerLeft,
  resetPlayerReadiness,
  setPlayerReady,
  upsertPlayer,
} from "@/lib/sessionProtocol";
import { createPeerId, createRoomId, createSignalingClient } from "@/lib/signalingClient";
import { createWebRtcRoom } from "@/lib/webrtcRoom";

const DEFAULT_PLAYLIST_ID = process.env.NEXT_PUBLIC_SONGLE_PLAYLIST_ID || "";
const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL || "";

function parsePlaylistOptions() {
  if (process.env.NEXT_PUBLIC_QUIZ_PLAYLISTS) {
    try {
      const parsedPlaylists = JSON.parse(process.env.NEXT_PUBLIC_QUIZ_PLAYLISTS);
      if (Array.isArray(parsedPlaylists)) {
        return parsedPlaylists
          .map((playlist) => ({
            id: playlist.id,
            name: playlist.name || playlist.id,
          }))
          .filter((playlist) => playlist.id);
      }
    } catch {
      // Fall back to the individual playlist env vars below.
    }
  }

  return [
  { id: process.env.NEXT_PUBLIC_SONGLE_PLAYLIST_ID, name: "Songle" },
  { id: process.env.NEXT_PUBLIC_1960s_PLAYLIST_ID, name: "1960s" },
  { id: process.env.NEXT_PUBLIC_1970s_PLAYLIST_ID, name: "1970s" },
  { id: process.env.NEXT_PUBLIC_1980s_PLAYLIST_ID, name: "1980s" },
  { id: process.env.NEXT_PUBLIC_1990s_PLAYLIST_ID, name: "1990s" },
  { id: process.env.NEXT_PUBLIC_2000s_PLAYLIST_ID, name: "2000s" },
  { id: process.env.NEXT_PUBLIC_2010s_PLAYLIST_ID, name: "2010s" },
  ].filter((playlist) => playlist.id);
}

const PLAYLIST_OPTIONS = parsePlaylistOptions();
const ROUND_COMPLETE_AUDIO_FALLBACK_MS = 800;
const ROUND_COMPLETE_FADE_BUFFER_MS = 80;
const QUIZ_CATALOG_CACHE_PREFIX = "quiz-catalog:";
const ROUND_START_DELAY_MS = 7000;
const WRONG_GUESS_POINTS = 50;
const PARTY_QUIZ_PATH = "/party-quiz";
const HOST_PLAYBACK_CONFIRM_TIMEOUT_MS = 5000;
const HOST_PLAYBACK_POLL_MS = 250;
const SPOTIFY_TRANSIENT_STATUSES = new Set([502, 503, 504]);

function formatTime(milliseconds) {
  const safeMilliseconds = Math.max(0, Math.floor(milliseconds || 0));
  const seconds = Math.floor(safeMilliseconds / 1000);
  const tenths = Math.floor((safeMilliseconds % 1000) / 100);
  return `${String(seconds).padStart(2, "0")}:${tenths}`;
}

function getOrigin() {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function playCountdownTick(value) {
  if (typeof window === "undefined") return;

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "square";
  oscillator.frequency.value = value === 1 ? 880 : 660;
  gain.gain.setValueAtTime(0.08, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.18);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.2);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getPlaybackTrackUri(playbackState) {
  return playbackState?.track_window?.current_track?.uri || playbackState?.currentTrackUri || "";
}

function isPlaybackStatePlayingTrack(playbackState, trackUri) {
  if (!playbackState || !trackUri) return false;
  return getPlaybackTrackUri(playbackState) === trackUri && playbackState.paused === false;
}

function createVote({ type, requestedBy, requestedByName, targetPlayerId, targetPlayerName, playlist }) {
  return {
    id: generateId(),
    type,
    requestedBy,
    requestedByName,
    targetPlayerId,
    targetPlayerName,
    playlist,
    votes: {
      [requestedBy]: true,
    },
    createdAt: Date.now(),
  };
}

function countVote(vote, session) {
  const activePlayers = getActivePlayers(session);
  const yesVotes = activePlayers.filter(
    (player) =>
      !(vote.type === "kick" && player.id === vote.targetPlayerId) &&
      vote.votes?.[player.id] === true
  ).length;
  const noVotes = activePlayers.filter(
    (player) =>
      (vote.type === "kick" && player.id === vote.targetPlayerId) ||
      vote.votes?.[player.id] === false
  ).length;

  return {
    yesVotes,
    noVotes,
    totalVotes: activePlayers.length,
    passed: yesVotes > activePlayers.length / 2,
  };
}

function pruneQuizCatalogCache(currentCacheKey) {
  if (typeof localStorage === "undefined") return;

  const catalogKeys = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(QUIZ_CATALOG_CACHE_PREFIX) && key !== currentCacheKey) {
      catalogKeys.push(key);
    }
  }

  catalogKeys.forEach((key) => localStorage.removeItem(key));
}

function readCachedQuizCatalog(cacheKey) {
  if (typeof localStorage === "undefined") return null;

  try {
    const cachedCatalog = localStorage.getItem(cacheKey);
    return cachedCatalog ? JSON.parse(cachedCatalog) : null;
  } catch {
    localStorage.removeItem(cacheKey);
    return null;
  }
}

function writeCachedQuizCatalog(cacheKey, catalog) {
  if (typeof localStorage === "undefined") return;

  const serializedCatalog = JSON.stringify(catalog);

  try {
    localStorage.setItem(cacheKey, serializedCatalog);
  } catch (error) {
    pruneQuizCatalogCache(cacheKey);

    try {
      localStorage.setItem(cacheKey, serializedCatalog);
    } catch (retryError) {
      console.warn("Could not cache quiz catalog.", retryError || error);
    }
  }
}

function createLiveSnapshot({ roomId, peerId, revision, session, catalog, localPlayer, phase }) {
  const nextRevision = revision || (session?.revision || 0) + 1;
  const sentAtEpoch = Date.now();

  return {
    roomId,
    peerId,
    sentAtEpoch,
    localPlayer,
    revision: nextRevision,
    phase,
    session: {
      ...session,
      revision: nextRevision,
      phase,
    },
    catalog,
  };
}

function translateCountdownSnapshotToLocalClock(snapshot) {
  if (
    !snapshot?.sentAtEpoch ||
    snapshot.phase !== "countdown" ||
    !snapshot.session?.currentRound?.startsAtEpoch
  ) {
    return snapshot;
  }

  const hostRemainingMs = snapshot.session.currentRound.startsAtEpoch - snapshot.sentAtEpoch;
  if (hostRemainingMs <= 0) return snapshot;

  const localStartsAtEpoch = Date.now() + hostRemainingMs;
  const currentRoundId = snapshot.session.currentRound.id;
  const translatedCurrentRound = {
    ...snapshot.session.currentRound,
    startsAtEpoch: localStartsAtEpoch,
  };
  const translatedSession = {
    ...snapshot.session,
    currentRound: translatedCurrentRound,
    rounds: snapshot.session.rounds.map((round) =>
      round.id === currentRoundId
        ? {
            ...round,
            startsAtEpoch: localStartsAtEpoch,
          }
        : round
    ),
  };

  return {
    ...snapshot,
    session: translatedSession,
  };
}

export default function QuizPage() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userData, setUserData] = useState(null);
  const [token, setToken] = useState("");
  const [roomId, setRoomId] = useState("");
  const [peerId, setPeerId] = useState("");
  const [peers, setPeers] = useState([]);
  const [hostPeerId, setHostPeerId] = useState("");
  const [isConnectedToSignal, setIsConnectedToSignal] = useState(false);
  const [connectedPeerIds, setConnectedPeerIds] = useState([]);
  const [signalStatus, setSignalStatus] = useState("");
  const [playlistId, setPlaylistId] = useState(DEFAULT_PLAYLIST_ID);
  const [playlistName, setPlaylistName] = useState("");
  const [playlistVoteId, setPlaylistVoteId] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [hostName, setHostName] = useState("Host");
  const [playerInfo, setPlayerInfo] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [session, setSession] = useState(null);
  const [localPlayer, setLocalPlayer] = useState(null);
  const [songGuess, setSongGuess] = useState("");
  const [artistGuess, setArtistGuess] = useState("");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [countdownValue, setCountdownValue] = useState(null);
  const [isSynchronizingRound, setIsSynchronizingRound] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [stopPlaying, setStopPlaying] = useState(false);
  const [stopPlaybackRequest, setStopPlaybackRequest] = useState(null);
  const [phase, setPhase] = useState("setup");
  const [status, setStatus] = useState("");
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [hasCopiedInvite, setHasCopiedInvite] = useState(false);
  const [pendingReady, setPendingReady] = useState(null);
  const [pendingReadyRoundNumber, setPendingReadyRoundNumber] = useState(null);
  const [autoReady, setAutoReady] = useState(false);
  const [uiEvents, setUiEvents] = useState([]);
  const [playlistNotice, setPlaylistNotice] = useState("");
  const [highlightedPlayers, setHighlightedPlayers] = useState({});
  const [highlightedScores, setHighlightedScores] = useState({});
  const [highlightedClaims, setHighlightedClaims] = useState({});
  const [correctGuessField, setCorrectGuessField] = useState("");
  const [wrongGuessField, setWrongGuessField] = useState("");
  const [isMobilePanelOpen, setIsMobilePanelOpen] = useState(false);
  const [isRoundCompleteEffect, setIsRoundCompleteEffect] = useState(false);
  const autoConnectedRoomRef = useRef("");
  const timerRef = useRef(null);
  const roundStartRef = useRef(null);
  const startedRoundIdRef = useRef(null);
  const countdownIntervalRef = useRef(null);
  const countdownTimeoutRef = useRef(null);
  const signalingRef = useRef(null);
  const webRtcRef = useRef(null);
  const sessionRef = useRef(null);
  const catalogRef = useRef(null);
  const tokenRef = useRef("");
  const playerInfoRef = useRef(null);
  const localPlayerRef = useRef(null);
  const isHostRef = useRef(false);
  const hostPeerIdRef = useRef("");
  const phaseRef = useRef("setup");
  const pendingReadyRef = useRef(null);
  const pendingReadyRoundNumberRef = useRef(null);
  const latestSnapshotRef = useRef(null);
  const snapshotRevisionRef = useRef(0);
  const roundStopRequestedAtRef = useRef(0);
  const songGuessPickerRef = useRef(null);
  const artistGuessPickerRef = useRef(null);
  const heardClaimIdsRef = useRef(new Set());
  const hostPlaybackStateRef = useRef(null);
  const hostPlaybackRuntimeRef = useRef(null);
  const liveStartedRoundIdsRef = useRef(new Set());

  const getJoinRoundNumber = (currentPhase = phaseRef.current, currentSession = sessionRef.current) => {
    const nextRoundNumber = (currentSession?.rounds.length || 0) + 1;
    return currentPhase === "round-live" || currentPhase === "countdown"
      ? nextRoundNumber + 1
      : nextRoundNumber;
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedPeerId = localStorage.getItem("songle-peer-id") || createPeerId();
    localStorage.setItem("songle-peer-id", storedPeerId);
    setPeerId(storedPeerId);
  }, []);

  useEffect(() => {
    if (!router.isReady) return;

    const queryRoomId = typeof router.query.room === "string" ? router.query.room : "";
    if (!queryRoomId) return;

    setRoomId(queryRoomId);
  }, [router.isReady, router.query.room]);

  useEffect(() => {
    const accessToken = Cookies.get("spotify_access_token");
    if (!accessToken) return;

    setToken(accessToken);
    setIsLoggedIn(true);
    fetch("/api/user")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) return;
        setUserData(data);
        setHostName(data.display_name || "Host");
      })
      .catch(() => {
        setUserData(null);
      });
  }, []);

  useEffect(() => {
    if (isLoggedIn || hostName !== "Host") return;

    const storedName = localStorage.getItem("songle-party-display-name");
    if (storedName) {
      setHostName(storedName);
      return;
    }

    const generatedName = `Player ${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem("songle-party-display-name", generatedName);
    setHostName(generatedName);
  }, [hostName, isLoggedIn]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (countdownTimeoutRef.current) clearTimeout(countdownTimeoutRef.current);
      webRtcRef.current?.close();
      signalingRef.current?.close();
    };
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    playerInfoRef.current = playerInfo;
  }, [playerInfo]);

  useEffect(() => {
    localPlayerRef.current = localPlayer;
  }, [localPlayer]);

  useEffect(() => {
    if (!peerId || !hostName || hostName === "Host") return;

    setLocalPlayer((currentPlayer) => {
      const playerToRename =
        currentPlayer ||
        createPlayer({
          id: peerId,
          name: hostName,
          isHost: isHostRef.current,
        });

      if (playerToRename.name === hostName) {
        if (signalingRef.current?.socket?.readyState === WebSocket.OPEN) {
          sendSessionMessage({
            type: "session:player-join",
            reliable: true,
            player: playerToRename,
          });
        }

        return playerToRename;
      }

      const renamedPlayer = {
        ...playerToRename,
        name: hostName,
      };

      setSession((previousSession) =>
        previousSession ? upsertPlayer(previousSession, renamedPlayer) : previousSession
      );

      if (signalingRef.current?.socket?.readyState === WebSocket.OPEN) {
        sendSessionMessage({
          type: "session:player-join",
          reliable: true,
          player: renamedPlayer,
        });
      }

      return renamedPlayer;
    });
  }, [hostName, peerId]);

  useEffect(() => {
    isHostRef.current = Boolean(peerId && hostPeerId === peerId);
    hostPeerIdRef.current = hostPeerId;
  }, [hostPeerId, peerId]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    pendingReadyRef.current = pendingReady;
  }, [pendingReady]);

  useEffect(() => {
    pendingReadyRoundNumberRef.current = pendingReadyRoundNumber;
  }, [pendingReadyRoundNumber]);

  useEffect(() => {
    if (!roomId || !session || !catalog || !localPlayer || !peerId) return;

    if (isHostRef.current) {
      snapshotRevisionRef.current += 1;
    } else {
      snapshotRevisionRef.current = Math.max(
        snapshotRevisionRef.current,
        session.revision || 0
      );
    }

    const snapshot = createLiveSnapshot({
      roomId,
      peerId,
      revision: snapshotRevisionRef.current,
      session,
      catalog,
      localPlayer,
      phase,
    });

    latestSnapshotRef.current = snapshot;

    if (!isHostRef.current) return;

    const snapshotMessage = {
      type: "session:snapshot",
      revision: snapshot.revision,
      state: snapshot,
    };

    const sentPeerCount = webRtcRef.current?.broadcast(snapshotMessage) || 0;
    const shouldAlsoSendViaSignaling =
      !sentPeerCount ||
      snapshot.phase === "countdown" ||
      snapshot.phase === "round-ended";

    if (shouldAlsoSendViaSignaling && signalingRef.current?.socket?.readyState === WebSocket.OPEN) {
      signalingRef.current.send(snapshotMessage);
    }
  }, [catalog, localPlayer, peerId, phase, roomId, session]);

  const applyIncomingSnapshot = (incomingSnapshot) => {
    if (!incomingSnapshot?.session) return;

    const translatedSnapshot = translateCountdownSnapshotToLocalClock(incomingSnapshot);
    const currentRevision = sessionRef.current?.revision || 0;
    if ((translatedSnapshot.revision || 0) < currentRevision) {
      return;
    }

    const nextLocalPlayer =
      localPlayerRef.current ||
      createPlayer({
        id: peerId || translatedSnapshot.peerId,
        name: hostName,
        isHost: false,
      });
    const playerAlreadyInSnapshot = translatedSnapshot.session.players.some(
      (player) => player.id === nextLocalPlayer.id
    );
    let incomingSession = playerAlreadyInSnapshot
      ? translatedSnapshot.session
      : upsertPlayer(translatedSnapshot.session, nextLocalPlayer);
    const pendingReadyValue = pendingReadyRef.current;
    const pendingRoundNumber = pendingReadyRoundNumberRef.current;
    const incomingReadyRoundNumber = incomingSession.rounds.length + 1;
    const hostEndedRound = translatedSnapshot.phase === "round-ended";

    if (
      hostEndedRound ||
      (pendingRoundNumber && pendingRoundNumber !== incomingReadyRoundNumber)
    ) {
      setPendingReady(null);
      setPendingReadyRoundNumber(null);
    } else if (pendingReadyValue !== null && !isHostRef.current) {
      const confirmedPlayer = incomingSession.players.find(
        (player) => player.id === nextLocalPlayer.id
      );

      if (confirmedPlayer?.ready === pendingReadyValue) {
        setPendingReady(null);
        setPendingReadyRoundNumber(null);
      } else {
        incomingSession = setPlayerReady(
          incomingSession,
          nextLocalPlayer.id,
          pendingReadyValue
        );
      }
    }

    snapshotRevisionRef.current = Math.max(snapshotRevisionRef.current, translatedSnapshot.revision || 0);
    setRoomId(translatedSnapshot.roomId);
    setCatalog(translatedSnapshot.catalog);
    setSession(incomingSession);
    setLocalPlayer(nextLocalPlayer);
    setPlaylistId(
      translatedSnapshot.session.playlistId ||
      translatedSnapshot.catalog.playlistId ||
      playlistId
    );
    setPlaylistName(translatedSnapshot.catalog.playlistName || playlistName);
    const nextPhase = translatedSnapshot.phase || "lobby";
    const phaseChanged = phaseRef.current !== nextPhase;
    setPhase(nextPhase);

    if (nextPhase === "round-ended" && phaseChanged) {
      setStatus("Round complete. Ready up for the next song.");
    }
  };

  const sendCurrentSnapshotTo = (targetPeerId) => {
    const snapshot = latestSnapshotRef.current;
    if (!snapshot) return;

    const snapshotMessage = {
        type: "session:snapshot",
        revision: snapshot.revision,
        state: snapshot,
    };

    if (!webRtcRef.current?.sendTo(targetPeerId, snapshotMessage)) {
      signalingRef.current?.send({
        ...snapshotMessage,
        to: targetPeerId,
      });
    }
  };

  const sendSessionMessage = (message) => {
    const sent = webRtcRef.current?.broadcast(message) || 0;

    if (
      (!sent || message.reliable) &&
      signalingRef.current?.socket?.readyState === WebSocket.OPEN
    ) {
      signalingRef.current.send(message);
    }
  };

  const applyHostClaim = (claim) => {
    setSession((previousSession) => {
      if (!previousSession) return previousSession;

      console.debug("[Songle quiz] host received claim", {
        claim,
        existingClaims: previousSession.currentRound?.claims || [],
      });
      const nextSession = applyClaim(previousSession, claim);
      const claimWasAccepted = nextSession !== previousSession;
      console.debug("[Songle quiz] host claim result", {
        claim,
        claimWasAccepted,
        nextClaims: nextSession.currentRound?.claims || [],
      });
      if (!claimWasAccepted) return previousSession;

      flashClaim(claim);
      flashScore(claim.playerId);
      if (!isRoundComplete(nextSession.currentRound)) {
        sendSessionMessage({
          type: "session:claim-accepted",
          reliable: true,
          claim,
          phase: nextSession.phase || phaseRef.current,
          session: nextSession,
        });
        return nextSession;
      }

      playRoundCompleteEffect();
      setTimeout(() => stopTimer({ stopPlayback: false }), 1800);
      setPendingReady(null);
      setPendingReadyRoundNumber(null);
      setPhase("round-ended");
      setStatus("Round complete. Ready up for the next song.");
      pushUiEvent("Round complete. Leaderboard updated.");
      const endedSession = {
        ...resetPlayerReadiness(nextSession),
        phase: "round-ended",
      };

      sendSessionMessage({
        type: "session:claim-accepted",
        reliable: true,
        claim,
        phase: "round-ended",
        session: endedSession,
      });
      setTimeout(() => {
        sendSessionMessage({
          type: "session:snapshot",
          reliable: true,
          revision: snapshotRevisionRef.current + 1,
          state: createLiveSnapshot({
            roomId,
            peerId,
            revision: snapshotRevisionRef.current + 1,
            session: endedSession,
            catalog: catalogRef.current,
            localPlayer: localPlayerRef.current,
            phase: "round-ended",
          }),
        });
      }, 0);

      return endedSession;
    });
  };

  const applyAcceptedClaim = ({ claim, session: acceptedSession, phase: acceptedPhase }) => {
    console.debug("[Songle quiz] apply accepted claim", {
      claim,
      acceptedPhase,
      acceptedClaims: acceptedSession?.currentRound?.claims || [],
    });
    if (acceptedSession) {
      setSession(acceptedSession);
      if (acceptedPhase || acceptedSession.phase) {
        setPhase(acceptedPhase || acceptedSession.phase);
      }
    } else if (claim) {
      setSession((previousSession) => (previousSession ? applyClaim(previousSession, claim) : previousSession));
    }

    if ((acceptedPhase || acceptedSession?.phase) === "round-ended") {
      setPendingReady(null);
      setPendingReadyRoundNumber(null);
      setStatus("Round complete. Ready up for the next song.");
    }

    if (claim) {
      flashClaim(claim);
      flashScore(claim.playerId);
    }
  };

  useEffect(() => {
    const claims = session?.currentRound?.claims || [];

    claims.forEach((claim) => {
      const claimId = `${claim.roundId}-${claim.field}-${claim.playerId}-${claim.elapsedMs}`;
      if (heardClaimIdsRef.current.has(claimId)) return;

      heardClaimIdsRef.current.add(claimId);
      playCorrectGuessEffect();
    });
  }, [session?.currentRound?.claims]);

  const playCorrectGuessEffect = () => {
    if (typeof window === "undefined") return;

    const audio = new Audio("/correct-guess.mp3");
    audio.volume = 0.65;
    audio.play().catch(() => {
      // Browser autoplay rules can block this if the page has not received interaction.
    });
  };

  const pushUiEvent = (text) => {
    if (!text) return;
    const id = generateId();
    setUiEvents((events) => [...events, { id, text }].slice(-3));
    setTimeout(() => {
      setUiEvents((events) => events.filter((event) => event.id !== id));
    }, 2800);
  };

  const flashPlayer = (playerId, kind = "join") => {
    if (!playerId) return;
    setHighlightedPlayers((current) => ({ ...current, [playerId]: kind }));
    setTimeout(() => {
      setHighlightedPlayers((current) => {
        const next = { ...current };
        delete next[playerId];
        return next;
      });
    }, 1400);
  };

  const flashScore = (playerId) => {
    if (!playerId) return;
    setHighlightedScores((current) => ({ ...current, [playerId]: true }));
    setTimeout(() => {
      setHighlightedScores((current) => {
        const next = { ...current };
        delete next[playerId];
        return next;
      });
    }, 1400);
  };

  const flashClaim = (claim) => {
    if (!claim) return;
    const key = `${claim.roundId}-${claim.playerId}-${claim.field}`;
    setHighlightedClaims((current) => ({ ...current, [key]: true }));
    setTimeout(() => {
      setHighlightedClaims((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 1600);
  };

  const showPlaylistNotice = (text) => {
    setPlaylistNotice(text);
    setTimeout(() => setPlaylistNotice(""), 2600);
  };

  const playRoundCompleteEffect = () => {
    setIsRoundCompleteEffect(true);
    setTimeout(() => setIsRoundCompleteEffect(false), 1800);

    if (typeof window === "undefined") return;

    const audio = new Audio("/dj-stop.mp3");
    audio.volume = 0.75;
    const requestId =
      generateId();
    let hasRequestedFade = false;
    const requestSyncedFade = (durationMs = ROUND_COMPLETE_AUDIO_FALLBACK_MS) => {
      if (hasRequestedFade) return;
      hasRequestedFade = true;
      fadeOutRound(
        Math.max(250, Math.floor(durationMs - ROUND_COMPLETE_FADE_BUFFER_MS)),
        requestId
      );
    };

    audio.addEventListener(
      "loadedmetadata",
      () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          requestSyncedFade(audio.duration * 1000);
        }
      },
      { once: true }
    );
    audio.addEventListener(
      "ended",
      () => {
        fadeOutRound(0, `${requestId}:ended`);
      },
      { once: true }
    );
    audio.play().catch(() => {
      // Browser autoplay rules can block this if the page has not received interaction.
    });
    requestSyncedFade(
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration * 1000
        : ROUND_COMPLETE_AUDIO_FALLBACK_MS
    );
  };

  const resolveKickVote = (vote) => {
    if (!isHostRef.current || !vote?.targetPlayerId) return;

    sendSessionMessage({
      type: "session:kick-resolved",
      reliable: true,
      voteId: vote.id,
      targetPlayerId: vote.targetPlayerId,
    });

    setSession((previousSession) =>
      previousSession ? markPlayerKicked(previousSession, vote.targetPlayerId) : previousSession
    );
  };

  const applyPlaylistChange = async (vote) => {
    if (!isHostRef.current || !vote?.playlist?.id) return;

    const currentSession = sessionRef.current;
    const canApplyNow =
      currentSession &&
      (phaseRef.current === "lobby" || phaseRef.current === "round-ended") &&
      !allPlayersReady(currentSession);

    if (!canApplyNow) {
      setStatus("Playlist change passed and will apply once the room is between rounds and not all players are ready.");
      return;
    }

    setIsLoadingCatalog(true);
    setStatus(`Changing playlist to ${vote.playlist.name}...`);

    try {
      const { playlist, catalog: nextCatalog } = await loadPlaylistCatalog(vote.playlist.id);

      setCatalog(nextCatalog);
      setPlaylistId(playlist.id);
      setPlaylistName(playlist.name || vote.playlist.name);
      setPendingReady(null);
      setPendingReadyRoundNumber(null);
      setSongGuess("");
      setArtistGuess("");
      setSession((previousSession) => {
        if (!previousSession) return previousSession;

        const changedSession = addActivity(
          {
            ...resetPlayerReadiness(previousSession),
            playlistId: playlist.id,
            catalogSnapshotId: nextCatalog.snapshotId,
            activeVote: null,
            currentRound: null,
            phase: "lobby",
          },
          `Playlist changed to ${playlist.name || vote.playlist.name}.`
        );
        return changedSession;
      });
      setPhase("lobby");
      showPlaylistNotice(`Playlist changed to ${playlist.name || vote.playlist.name}`);
      pushUiEvent(`Playlist changed to ${playlist.name || vote.playlist.name}.`);
      setStatus("");
    } catch (error) {
      console.error("Error changing playlist:", error);
      setStatus(error.message || "Could not change playlist.");
    } finally {
      setIsLoadingCatalog(false);
    }
  };

  const maybeResolveVote = (nextSession) => {
    if (!isHostRef.current || !nextSession?.activeVote) return;

    const nextVote = nextSession.activeVote;
    const nextVoteCount = countVote(nextVote, nextSession);
    if (!nextVoteCount.passed) {
      if (nextVoteCount.noVotes >= Math.ceil(nextVoteCount.totalVotes / 2)) {
        setTimeout(() => {
          sendSessionMessage({
            type: "session:vote-failed",
            reliable: true,
            voteId: nextVote.id,
          });
          setSession((previousSession) =>
            previousSession?.activeVote?.id === nextVote.id
              ? addActivity(
                  { ...previousSession, activeVote: null },
                  "Vote did not pass."
                )
              : previousSession
          );
        }, 0);
      }
      return;
    }

    if (nextVote.type === "kick") {
      setTimeout(() => resolveKickVote(nextVote), 0);
      return;
    }

    if (nextVote.type === "playlist-change") {
      setTimeout(() => applyPlaylistChange(nextVote), 0);
    }
  };

  const applyVoteStarted = (vote) => {
    setSession((previousSession) => {
      if (!previousSession) return previousSession;

      const nextSession = addActivity(
        {
          ...previousSession,
          activeVote: vote,
        },
        vote.type === "kick"
          ? `${vote.requestedByName} started a vote to remove ${vote.targetPlayerName}.`
          : `${vote.requestedByName} requested ${vote.playlist.name}.`
      );
      maybeResolveVote(nextSession);
      return nextSession;
    });
  };

  const applyVoteCast = ({ voteId, playerId, vote }) => {
    setSession((previousSession) => {
      if (!previousSession?.activeVote || previousSession.activeVote.id !== voteId) {
        return previousSession;
      }

      const nextSession = {
        ...previousSession,
        activeVote: {
          ...previousSession.activeVote,
          votes: {
            ...previousSession.activeVote.votes,
            [playerId]: vote,
          },
        },
      };
      maybeResolveVote(nextSession);
      return nextSession;
    });
  };

  const handleSessionMessage = (message, remotePeerId) => {
    if (message.type === "session:snapshot") {
      applyIncomingSnapshot(message.state);
      return;
    }

    if (message.type === "session:player-join") {
      let joinedSession = null;
      setSession((previousSession) => {
        if (!previousSession) return previousSession;

        const joiningPlayer = {
          ...message.player,
          ready:
            message.player?.joinRoundNumber && message.player.joinRoundNumber > previousSession.rounds.length + 1
              ? false
              : message.player?.ready,
        };
        joinedSession = upsertPlayer(previousSession, joiningPlayer);
        return joinedSession;
      });
      if (message.player?.id !== peerId) {
        flashPlayer(message.player?.id, "join");
        pushUiEvent(`${message.player?.name || "A player"} joined.`);
      }
      if (isHostRef.current && joinedSession) {
        sendSessionMessage({
          type: "session:snapshot",
          reliable: true,
          revision: joinedSession.revision || snapshotRevisionRef.current,
          state: createLiveSnapshot({
            roomId,
            peerId,
            revision: snapshotRevisionRef.current,
            session: joinedSession,
            catalog: catalogRef.current,
            localPlayer: localPlayerRef.current,
            phase: phaseRef.current,
          }),
        });
      }
      return;
    }

    if (message.type === "session:player-ready") {
      setSession((previousSession) => {
        if (!previousSession) return previousSession;
        const expectedReadyRoundNumber = previousSession.rounds.length + 1;

        if (
          message.readyRoundNumber &&
          message.readyRoundNumber !== expectedReadyRoundNumber
        ) {
          return previousSession;
        }

        const nextSession = message.player
          ? upsertPlayer(previousSession, message.player)
          : previousSession;

        return setPlayerReady(
          nextSession,
          message.playerId || remotePeerId,
          message.ready
        );
      });
      flashPlayer(message.playerId || remotePeerId, message.ready ? "ready" : "unready");
      return;
    }

    if (message.type === "session:player-left") {
      setSession((previousSession) =>
        previousSession ? markPlayerLeft(previousSession, message.playerId || remotePeerId) : previousSession
      );
      pushUiEvent("A player left the room.");
      return;
    }

    if (message.type === "session:vote-started") {
      applyVoteStarted(message.vote);
      return;
    }

    if (message.type === "session:vote-cast") {
      applyVoteCast(message);
      return;
    }

    if (message.type === "session:kick-resolved") {
      if (message.targetPlayerId === peerId) {
        setStatus("You were removed from the session.");
        webRtcRef.current?.close();
        signalingRef.current?.close();
      }

      setSession((previousSession) =>
        previousSession ? markPlayerKicked(previousSession, message.targetPlayerId) : previousSession
      );
      return;
    }

    if (message.type === "session:vote-failed") {
      setSession((previousSession) =>
        previousSession?.activeVote?.id === message.voteId
          ? addActivity(
              { ...previousSession, activeVote: null },
              "Vote did not pass."
            )
          : previousSession
      );
      return;
    }

    if (message.type === "session:claim" && isHostRef.current) {
      applyHostClaim(message.claim);
      return;
    }

    if (message.type === "session:claim-accepted" && !isHostRef.current) {
      applyAcceptedClaim(message);
      return;
    }

    if (message.type === "session:wrong-guess") {
      setSession((previousSession) =>
        previousSession
          ? applyWrongGuess(previousSession, {
              playerId: message.playerId,
              field: message.field,
              guessText: message.guessText,
            })
          : previousSession
      );
      flashScore(message.playerId);
      return;
    }

    if (message.type === "session:start-request" && isHostRef.current) {
      startRound();
    }
  };

  const currentTrack = useMemo(() => {
    if (!catalog || !session?.currentRound) return null;
    return catalog.tracksById[session.currentRound.trackId];
  }, [catalog, session]);

  const songNames = useMemo(() => {
    if (!catalog) return [];
    return catalog.tracks.map((track) => track.name).sort((a, b) => a.localeCompare(b));
  }, [catalog]);

  const artistNames = useMemo(() => {
    if (!catalog) return [];
    return getUniqueArtists(catalog);
  }, [catalog]);

  const localClaims = useMemo(() => {
    if (!session?.currentRound || !localPlayer) return [];
    return session.currentRound.claims.filter(
      (claim) => claim.playerId === localPlayer.id
    );
  }, [localPlayer, session]);
  const songClaim = session?.currentRound?.claims.find((claim) => claim.field === "song");
  const artistClaim = session?.currentRound?.claims.find((claim) => claim.field === "artist");
  const songSolved = Boolean(songClaim);
  const artistSolved = Boolean(artistClaim);
  const roundIsEnded = phase === "round-ended" || session?.phase === "round-ended";
  const songFieldClosed = Boolean(songClaim && (roundIsEnded || elapsedTime >= songClaim.elapsedMs));
  const artistFieldClosed = Boolean(artistClaim && (roundIsEnded || elapsedTime >= artistClaim.elapsedMs));
  const correctSongDisplay = currentTrack?.name || "";
  const correctArtistDisplay = currentTrack?.artists?.join(", ") || "";

  const hasSongClaim = localClaims.some((claim) => claim.field === "song");
  const hasArtistClaim = localClaims.some((claim) => claim.field === "artist");
  const isHost = Boolean(peerId && hostPeerId === peerId);
  const localPlaybackReady = !isHost || Boolean(playerInfo?.ready);
  const canToggleReady = Boolean(localPlayer && catalog && !isRunning && phase !== "countdown");
  const activePlayers = useMemo(() => (session ? getActivePlayers(session) : []), [session]);
  const roundReadyPlayers = useMemo(() => (session ? getRoundReadyPlayers(session) : []), [session]);
  const inactivePlayers = useMemo(
    () => (session ? session.players.filter((player) => !player.connected && !player.kicked) : []),
    [session]
  );
  const readyPlayers = roundReadyPlayers.filter((player) => player.ready).length;
  const allReady = session ? allPlayersReady(session) : false;
  const localPlayerReady = Boolean(
    localPlayer && session?.players.find((player) => player.id === localPlayer.id)?.ready
  );
  const readyButtonLabel = pendingReady !== null
    ? (pendingReady ? "Unready" : "Ready Up")
    : (localPlayerReady ? "Unready" : "Ready Up");
  const readySummary = session
    ? `Ready ${readyPlayers}/${roundReadyPlayers.length}`
    : "";
  const inviteLink = roomId ? `${getOrigin()}${PARTY_QUIZ_PATH}?room=${roomId}` : "";
  const playerNameById = useMemo(() => {
    return Object.fromEntries((session?.players || []).map((player) => [player.id, player.name]));
  }, [session?.players]);
  const activeVote = session?.activeVote || null;
  const voteCount = activeVote && session ? countVote(activeVote, session) : null;
  const localVote = activeVote && localPlayer ? activeVote.votes?.[localPlayer.id] : undefined;
  const playlistVoteOptions = useMemo(
    () => PLAYLIST_OPTIONS.filter((playlist) => playlist.id !== playlistId),
    [playlistId]
  );
  const selectedPlaylistVote =
    playlistVoteOptions.find((playlist) => playlist.id === playlistVoteId) ||
    playlistVoteOptions[0] ||
    null;
  const hostDisplayName =
    session?.players.find((player) => player.id === hostPeerId)?.name ||
    session?.hostName ||
    hostName;

  useEffect(() => {
    if (!playlistVoteOptions.length) {
      setPlaylistVoteId("");
      return;
    }

    if (!playlistVoteOptions.some((playlist) => playlist.id === playlistVoteId)) {
      setPlaylistVoteId(playlistVoteOptions[0].id);
    }
  }, [playlistId, playlistVoteId, playlistVoteOptions]);

  const copyInviteLink = async () => {
    if (!inviteLink) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteLink);
      } else {
        const el = document.createElement("textarea");
        el.value = inviteLink;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setHasCopiedInvite(true);
      setTimeout(() => setHasCopiedInvite(false), 1500);
    } catch {
      setStatus(`Invite link: ${inviteLink}`);
    }
  };

  const joinRoom = () => {
    const nextRoomId = joinRoomId.trim();
    if (!nextRoomId) return;

    setRoomId(nextRoomId);
    router.replace(`${PARTY_QUIZ_PATH}?room=${encodeURIComponent(nextRoomId)}`, undefined, {
      shallow: true,
    });
  };

  const connectToSignaling = (options = {}) => {
    if (!SIGNALING_URL) {
      setSignalStatus("Set NEXT_PUBLIC_SIGNALING_URL to connect to the signaling worker.");
      return;
    }

    if (!peerId || signalingRef.current?.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const nextRoomId = roomId || createRoomId();
    const nextLocalPlayer =
      localPlayer ||
      createPlayer({
        id: peerId,
        name: hostName,
        isHost: Boolean(session),
      });
    const nextLocalPlayerWithJoinRound = {
      ...nextLocalPlayer,
      joinRoundNumber: nextLocalPlayer.joinRoundNumber || getJoinRoundNumber(),
      ready:
        nextLocalPlayer.joinRoundNumber && nextLocalPlayer.joinRoundNumber > (sessionRef.current?.rounds.length || 0) + 1
          ? false
          : nextLocalPlayer.ready,
    };

    setLocalPlayer(nextLocalPlayerWithJoinRound);

    if (!roomId && !options.silent) {
      setRoomId(nextRoomId);
      router.replace(`${PARTY_QUIZ_PATH}?room=${nextRoomId}`, undefined, { shallow: true });
    } else if (!roomId) {
      setRoomId(nextRoomId);
    }

    signalingRef.current?.close();
    webRtcRef.current?.close();
    const client = createSignalingClient({
      baseUrl: SIGNALING_URL,
      roomId: nextRoomId,
      peerId,
      name: nextLocalPlayerWithJoinRound.name,
      role: session ? "host" : "player",
      canHost: Boolean(tokenRef.current),
    });

    signalingRef.current = client;
    const webRtcRoom = createWebRtcRoom({
      peerId,
      signal: (to, payload) => {
        client.send({
          type: "signal",
          to,
          payload,
        });
      },
    });

    webRtcRef.current = webRtcRoom;
    setSignalStatus("Connecting to signaling room...");

    webRtcRoom.on("peer:open", ({ peerId: remotePeerId }) => {
      setConnectedPeerIds(webRtcRoom.getConnectedPeerIds());
      setSignalStatus("Peer data channel connected.");
      if (localPlayerRef.current) {
        webRtcRoom.sendTo(remotePeerId, {
          type: "session:player-join",
          reliable: true,
          player: localPlayerRef.current,
        });
      }
      if (isHostRef.current || remotePeerId === hostPeerIdRef.current) {
        sendCurrentSnapshotTo(remotePeerId);
      }
    });

    webRtcRoom.on("peer:close", () => {
      setConnectedPeerIds(webRtcRoom.getConnectedPeerIds());
    });

    webRtcRoom.on("message", ({ message, peerId: remotePeerId }) => {
      handleSessionMessage(message, remotePeerId);
    });

    client.socket.addEventListener("open", () => {
      setIsConnectedToSignal(true);
      setSignalStatus("Connected to signaling room.");
      client.send({
        type: "session:player-join",
        reliable: true,
        player: nextLocalPlayerWithJoinRound,
      });

      if (nextLocalPlayerWithJoinRound.joinRoundNumber > (sessionRef.current?.rounds.length || 0) + 1) {
        setStatus("Song already in progress. You will join the next round.");
      }

    });

    client.socket.addEventListener("close", () => {
      setIsConnectedToSignal(false);
      setSignalStatus("Disconnected from signaling room.");
    });

    client.on("room:welcome", (message) => {
      hostPeerIdRef.current = message.hostPeerId;

      setHostPeerId(message.hostPeerId);
      setPeers(message.peers || []);

      (message.peers || [])
        .filter((peer) => peer.peerId < peerId)
        .forEach((peer) => {
          webRtcRoom.callPeer(peer.peerId).catch((error) => {
            console.error("Error calling peer:", error);
          });
        });
    });

    client.on("peer:joined", (message) => {
      setPeers((currentPeers) => [
        ...currentPeers.filter((peer) => peer.peerId !== message.peer.peerId),
        message.peer,
      ]);

      if (peerId > message.peer.peerId) {
        webRtcRoom.callPeer(message.peer.peerId).catch((error) => {
          console.error("Error calling joined peer:", error);
        });
      }
    });

    client.on("peer:left", (message) => {
      setPeers((currentPeers) =>
        currentPeers.filter((peer) => peer.peerId !== message.peerId)
      );
      webRtcRoom.removePeer(message.peerId);
      setConnectedPeerIds(webRtcRoom.getConnectedPeerIds());
      setSession((previousSession) =>
        previousSession ? markPlayerLeft(previousSession, message.peerId) : previousSession
      );
      pushUiEvent("A player left the room.");
    });

    client.on("host:changed", (message) => {
      hostPeerIdRef.current = message.hostPeerId;
      setHostPeerId(message.hostPeerId);
      setSignalStatus(
        !message.hostPeerId
          ? "Waiting for the Spotify host to reconnect."
          : message.hostPeerId === peerId
          ? "You are now the live room host."
          : "The live room host changed."
      );

      if (message.hostPeerId && message.hostPeerId !== peerId) {
        setTimeout(() => sendCurrentSnapshotTo(message.hostPeerId), 0);
      }
    });

    client.on("signal", (message) => {
      webRtcRoom.handleSignal(message.from, message.payload).catch((error) => {
        console.error("Error handling WebRTC signal:", error);
      });
    });

    client.on("session:snapshot", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:player-join", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:player-ready", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:player-left", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:vote-started", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:vote-cast", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:kick-resolved", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:vote-failed", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:claim", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:claim-accepted", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:wrong-guess", (message) => {
      handleSessionMessage(message, message.from);
    });

    client.on("session:start-request", (message) => {
      handleSessionMessage(message, message.from);
    });
  };

  useEffect(() => {
    if (!roomId || !peerId || autoConnectedRoomRef.current === roomId) return;

    autoConnectedRoomRef.current = roomId;
    connectToSignaling({ silent: true });
  }, [peerId, roomId]);

  const loadPlaylistCatalog = async (nextPlaylistId) => {
    const normalizedPlaylistId = getPlaylistId(nextPlaylistId);
    const playlistResponse = await getPlaylist(tokenRef.current, normalizedPlaylistId);
    if (!playlistResponse.ok) {
      let details = "";
      try {
        const errorBody = await playlistResponse.json();
        details = errorBody?.error?.message ? ` ${errorBody.error.message}` : "";
      } catch {
        details = "";
      }

      throw new Error(
        `Spotify returned ${playlistResponse.status} for playlist ${normalizedPlaylistId}.${details}`
      );
    }

    const playlist = await playlistResponse.json();
    const cacheKey = `quiz-catalog:${playlist.id}:${playlist.snapshot_id}`;
    const cachedCatalog = readCachedQuizCatalog(cacheKey);

    if (cachedCatalog) {
      return {
        playlist,
        catalog: cachedCatalog,
      };
    }

    const tracks = await getSongsFromPlaylist(tokenRef.current, null, playlist.id);
    if (!tracks) {
      throw new Error(`Spotify did not return tracks for playlist ${playlist.id}.`);
    }
    const nextCatalog = buildQuizCatalog({
      playlistId: playlist.id,
      playlistName: playlist.name,
      playlistUri: playlist.uri,
      snapshotId: playlist.snapshot_id,
      tracks,
    });
    writeCachedQuizCatalog(cacheKey, nextCatalog);

    return {
      playlist,
      catalog: nextCatalog,
    };
  };

  const fetchCatalog = async () => {
    if (!token || !playlistId) return;

    setIsLoadingCatalog(true);
    setStatus("Fetching playlist catalog...");

    try {
      const { playlist, catalog: nextCatalog } = await loadPlaylistCatalog(playlistId);
      const nextRoomId = roomId || createRoomId();

      const host = {
        ...createPlayer({ id: peerId, name: hostName, isHost: true }),
        ready: autoReady,
      };
      const nextSession = createSession({
        playlistId: playlist.id,
        catalog: nextCatalog,
        hostName,
      });

      setCatalog(nextCatalog);
      setPlaylistName(playlist.name || "Songle");
      setLocalPlayer(host);
      setRoomId(nextRoomId);
      setHostPeerId(peerId);
      setSession({
        ...nextSession,
        id: nextRoomId,
        phase: "lobby",
        revision: snapshotRevisionRef.current,
        players: [host],
      });
      setPhase("lobby");
      router.replace(`${PARTY_QUIZ_PATH}?room=${nextRoomId}`, undefined, { shallow: true });
      setStatus(`Loaded ${nextCatalog.tracks.length} songs from the host playlist.`);
    } catch (error) {
      console.error("Error creating quiz session:", error);
      setStatus(error.message || "Could not create the quiz session. Check the playlist ID and Spotify login.");
    } finally {
      setIsLoadingCatalog(false);
    }
  };

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);

    roundStartRef.current = performance.now();
    setElapsedTime(0);
    setIsRunning(true);
    timerRef.current = setInterval(() => {
      setElapsedTime(performance.now() - roundStartRef.current);
    }, 100);
  };

  const stopTimer = ({ stopPlayback = true, fadeMs = 900 } = {}) => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setIsRunning(false);
    if (stopPlayback) {
      fadeOutRound(fadeMs);
    }
  };

  const clearCountdown = () => {
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    if (countdownTimeoutRef.current) clearTimeout(countdownTimeoutRef.current);
    countdownIntervalRef.current = null;
    countdownTimeoutRef.current = null;
    setCountdownValue(null);
    setIsSynchronizingRound(false);
  };

  const beginLiveRound = (round, nextStatus) => {
    if (!round || liveStartedRoundIdsRef.current.has(round.id)) return;

    liveStartedRoundIdsRef.current.add(round.id);
    startTimer();
    setPhase("round-live");
    setStatus(nextStatus);
  };

  const activateHostPlaybackElement = async () => {
    try {
      await hostPlaybackRuntimeRef.current?.activateElement?.();
    } catch (error) {
      console.warn("Could not activate Spotify playback element.", error);
    }
  };

  const readHostPlaybackState = async () => {
    const runtime = hostPlaybackRuntimeRef.current;
    if (!runtime?.getCurrentState) return hostPlaybackStateRef.current;

    try {
      const sdkState = await runtime.getCurrentState();
      if (sdkState) {
        const nextState = {
          ...hostPlaybackStateRef.current,
          active: true,
          paused: sdkState.paused,
          currentTrackUri: sdkState.track_window?.current_track?.uri,
          currentTrackId: sdkState.track_window?.current_track?.id,
          position: sdkState.position,
        };
        hostPlaybackStateRef.current = nextState;
        return nextState;
      }
    } catch (error) {
      console.warn("Could not read Spotify playback state.", error);
    }

    return hostPlaybackStateRef.current;
  };

  const waitForHostPlayback = async (round, timeoutMs = HOST_PLAYBACK_CONFIRM_TIMEOUT_MS) => {
    const startedAt = performance.now();

    while (performance.now() - startedAt < timeoutMs) {
      const playbackState = await readHostPlaybackState();
      if (isPlaybackStatePlayingTrack(playbackState, round.trackUri)) {
        return true;
      }
      await wait(HOST_PLAYBACK_POLL_MS);
    }

    return false;
  };

  const recoverHostPlayback = async () => {
    const round = sessionRef.current?.currentRound;
    if (!round || !isHostRef.current) return;

    setStatus("Checking host Spotify playback...");
    const isPlaying = await waitForHostPlayback(round, 1200);
    if (isPlaying) {
      beginLiveRound(round, "Round live. Host playback recovered.");
      return;
    }

    setStatus("Host playback is not confirmed yet. Try again once the song is audible.");
  };

  const scheduleRoundPlayback = (round) => {
    if (!round || startedRoundIdRef.current === round.id) return;

    clearCountdown();
    startedRoundIdRef.current = round.id;
    setSongGuess("");
    setArtistGuess("");
    setStopPlaying(false);
    setIsRunning(false);
    setIsSynchronizingRound(round.startsAtEpoch > Date.now() + 3000);
    setStatus(
      round.startsAtEpoch <= Date.now()
        ? "Round start received late. Starting playback now..."
        : "Get ready..."
    );

    const updateCountdown = () => {
      const secondsLeft = Math.ceil((round.startsAtEpoch - Date.now()) / 1000);
      const visibleValue = secondsLeft > 0 && secondsLeft <= 3 ? secondsLeft : null;
      setIsSynchronizingRound(secondsLeft > 3);
      setCountdownValue((previousValue) => {
        if (visibleValue && visibleValue !== previousValue) {
          playCountdownTick(visibleValue);
        }
        return visibleValue;
      });
    };

    updateCountdown();
    countdownIntervalRef.current = setInterval(updateCountdown, 100);

    countdownTimeoutRef.current = setTimeout(async () => {
      clearCountdown();

      const shouldPlayLocalAudio = isHostRef.current;
      const spotifyPlayer = playerInfoRef.current;
      const spotifyToken = tokenRef.current;

      if (shouldPlayLocalAudio) {
        if (!spotifyPlayer?.ready || !spotifyToken) {
          setStatus("Host Spotify player is not ready.");
          startedRoundIdRef.current = null;
          return;
        }

        await activateHostPlaybackElement();
        setStatus("Starting host Spotify playback...");

        try {
          const response = await playTrackUri(spotifyToken, round.trackUri, spotifyPlayer.id);

          if (response.ok) {
            beginLiveRound(round, "Round live. Playing from this host device.");
            return;
          }

          if (SPOTIFY_TRANSIENT_STATUSES.has(response.status)) {
            console.warn("Spotify returned a transient playback status.", {
              status: response.status,
              trackUri: round.trackUri,
              deviceId: spotifyPlayer.id,
            });
            setStatus(`Spotify returned ${response.status}. Confirming whether playback started...`);

            if (await waitForHostPlayback(round)) {
              beginLiveRound(round, "Round live. Spotify started after a delayed response.");
              return;
            }

            setStatus("Retrying host Spotify playback...");
            await wait(600);
            const retryResponse = await playTrackUri(spotifyToken, round.trackUri, spotifyPlayer.id);

            if (retryResponse.ok || (await waitForHostPlayback(round))) {
              beginLiveRound(round, "Round live. Host playback recovered after retry.");
              return;
            }

            setStatus(`Spotify could not confirm playback (${retryResponse.status}).`);
            startedRoundIdRef.current = null;
            return;
          }

          setStatus(`Spotify could not start playback (${response.status}).`);
          startedRoundIdRef.current = null;
          return;
        } catch (error) {
          console.error("Error starting synchronized playback:", error);
          setStatus("Spotify request failed. Checking whether playback started...");

          if (await waitForHostPlayback(round)) {
            beginLiveRound(round, "Round live. Spotify started after a delayed response.");
            return;
          }

          setStatus("Could not start synchronized playback.");
          startedRoundIdRef.current = null;
          return;
        }
      }

      beginLiveRound(round, "Round live. Listen to the host speaker and guess fast.");
    }, Math.max(0, round.startsAtEpoch - Date.now()));
  };

  const retryHostPlayback = () => {
    const round = sessionRef.current?.currentRound;
    if (!round || !isHostRef.current) return;

    startedRoundIdRef.current = null;
    scheduleRoundPlayback({
      ...round,
      startsAtEpoch: Date.now(),
    });
  };

  useEffect(() => {
    if (session?.phase === "countdown" && session.currentRound) {
      scheduleRoundPlayback(session.currentRound);
      return;
    }

    if (session?.phase === "round-ended") {
      clearCountdown();
      const recentlyRequestedRoundStop = Date.now() - roundStopRequestedAtRef.current < 2000;
      stopTimer({ stopPlayback: !recentlyRequestedRoundStop });
    }
  }, [session?.currentRound?.id, session?.phase]);

  const startRound = async () => {
    const currentCatalog = catalogRef.current;
    const currentSession = sessionRef.current;
    const currentPlayerInfo = playerInfoRef.current;

    if (
      !currentCatalog ||
      !currentSession ||
      !currentPlayerInfo?.ready ||
      !allPlayersReady(currentSession)
    ) {
      return;
    }

    await activateHostPlaybackElement();

    const usedTrackIds = new Set(currentSession.rounds.map((round) => round.trackId));
    const availableTrackIds = currentCatalog.trackIds.filter((trackId) => !usedTrackIds.has(trackId));
    const pool = availableTrackIds.length > 0 ? availableTrackIds : currentCatalog.trackIds;
    const trackId = pool[Math.floor(Math.random() * pool.length)];
    const track = currentCatalog.tracksById[trackId];
    const round = createRound({
      roundNumber: currentSession.rounds.length + 1,
      trackId,
      trackUri: track.uri,
      startsAtEpoch: Date.now() + ROUND_START_DELAY_MS,
    });

    setSongGuess("");
    setArtistGuess("");
    setStopPlaying(false);
    setPhase("countdown");
    setStatus("Starting synchronized countdown...");

    setSession((previousSession) => ({
      ...previousSession,
      currentRound: round,
      rounds: [...previousSession.rounds, round],
      phase: "countdown",
    }));
  };

  const setReadyForRound = () => {
    if (!canToggleReady) return;
    if (isHost) {
      activateHostPlaybackElement();
    }
    const nextRoundNumber = (sessionRef.current?.rounds.length || 0) + 1;
    if ((localPlayer.joinRoundNumber || 1) > nextRoundNumber) {
      setStatus("Song already in progress. You will join the next round.");
      return;
    }
    const nextReady = !localPlayerReady;

    setSession((previousSession) =>
      previousSession ? setPlayerReady(previousSession, localPlayer.id, nextReady) : previousSession
    );
    setLocalPlayer((previousPlayer) =>
      previousPlayer ? { ...previousPlayer, ready: nextReady } : previousPlayer
    );
    setPendingReady(nextReady);
    setPendingReadyRoundNumber((sessionRef.current?.rounds.length || 0) + 1);
    flashPlayer(localPlayer.id, nextReady ? "ready" : "unready");
    pushUiEvent(nextReady ? `${localPlayer.name} is ready.` : `${localPlayer.name} is not ready.`);

    sendSessionMessage({
      type: "session:player-ready",
      reliable: true,
      playerId: localPlayer.id,
      readyRoundNumber: (sessionRef.current?.rounds.length || 0) + 1,
      player: {
        ...localPlayer,
        ready: nextReady,
      },
      ready: nextReady,
    });
    setStatus(
      signalingRef.current?.socket?.readyState === WebSocket.OPEN
        ? (nextReady ? "Ready." : "Not ready.")
        : "Ready changed locally, but signaling is not connected."
    );
  };

  useEffect(() => {
    if (!autoReady || !localPlayer || !canToggleReady || localPlayerReady) return;
    if (isRunning) return;
    const currentPhase = sessionRef.current?.phase || phase;
    if (currentPhase !== "lobby" && currentPhase !== "round-ended") return;

    const nextRoundNumber = (sessionRef.current?.rounds.length || 0) + 1;
    if ((localPlayer.joinRoundNumber || 1) > nextRoundNumber) return;

    setReadyForRound();
  }, [autoReady, canToggleReady, isRunning, localPlayer, localPlayerReady, phase, session?.phase, session?.rounds.length]);

  const fadeOutRound = (fadeMs = 900, requestId = null) => {
    roundStopRequestedAtRef.current = Date.now();
    setStopPlaying(true);
    setStopPlaybackRequest({
      id:
        requestId ||
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? generateId()
          : `${Date.now()}-${Math.random()}`),
      fadeMs,
    });
  };

  const requestStartRound = () => {
    if (isHost) {
      startRound();
      return;
    }

    sendSessionMessage({
      type: "session:start-request",
      reliable: true,
      playerId: localPlayer?.id,
    });
    setStatus("Start request sent to host.");
  };

  const startVote = (vote) => {
    applyVoteStarted(vote);
    sendSessionMessage({
      type: "session:vote-started",
      reliable: true,
      vote,
    });
  };

  const startKickVote = (targetPlayer) => {
    if (!localPlayer || !targetPlayer || targetPlayer.id === localPlayer.id || activeVote) return;

    startVote(
      createVote({
        type: "kick",
        requestedBy: localPlayer.id,
        requestedByName: localPlayer.name,
        targetPlayerId: targetPlayer.id,
        targetPlayerName: targetPlayer.name,
      })
    );
  };

  const requestPlaylistChange = (nextPlaylist) => {
    if (!localPlayer || !nextPlaylist || activeVote) return;

    if (nextPlaylist.id === playlistId) {
      setStatus("That playlist is already active.");
      return;
    }

    if (phase !== "lobby" && phase !== "round-ended") {
      setStatus("Playlist changes can only be requested between rounds.");
      return;
    }

    if (allReady) {
      setStatus("Playlist changes can only be requested before everyone is ready.");
      return;
    }

    startVote(
      createVote({
        type: "playlist-change",
        requestedBy: localPlayer.id,
        requestedByName: localPlayer.name,
        playlist: nextPlaylist,
      })
    );
  };

  const castVote = (vote) => {
    if (!activeVote || !localPlayer) return;
    const nextVote =
      activeVote.type === "kick" && activeVote.targetPlayerId === localPlayer.id
        ? false
        : vote;

    applyVoteCast({
      voteId: activeVote.id,
      playerId: localPlayer.id,
      vote: nextVote,
    });
    sendSessionMessage({
      type: "session:vote-cast",
      reliable: true,
      voteId: activeVote.id,
      playerId: localPlayer.id,
      vote: nextVote,
    });
  };

  const submitClaim = (field, guess) => {
    if (!session?.currentRound || !currentTrack || !localPlayer || !roundStartRef.current) {
      console.debug("[Songle quiz] claim ignored before validation", {
        field,
        guess,
        hasRound: Boolean(session?.currentRound),
        hasTrack: Boolean(currentTrack),
        hasLocalPlayer: Boolean(localPlayer),
        hasRoundStart: Boolean(roundStartRef.current),
      });
      return;
    }

    const isCorrect =
      field === "song"
        ? verifySongGuess(currentTrack, guess)
        : verifyArtistGuess(currentTrack, guess);

    console.debug("[Songle quiz] claim validation", {
      field,
      guess,
      isCorrect,
      trackId: currentTrack.id,
      trackName: currentTrack.name,
      artists: currentTrack.artists,
      currentClaims: session.currentRound.claims,
    });

    if (!isCorrect) {
      setWrongGuessField("");
      requestAnimationFrame(() => {
        setWrongGuessField(field);
        setTimeout(() => setWrongGuessField(""), 850);
      });
      if (field === "song") {
        setSongGuess("");
      } else {
        setArtistGuess("");
      }
      setSession((previousSession) =>
        previousSession
          ? applyWrongGuess(previousSession, {
              playerId: localPlayer.id,
              field,
              guessText: guess,
            })
          : previousSession
      );
      sendSessionMessage({
        type: "session:wrong-guess",
        reliable: true,
        playerId: localPlayer.id,
        field,
        guessText: guess,
      });
      flashScore(localPlayer.id);
      console.debug("[Songle quiz] wrong guess applied", {
        field,
        guess,
        playerId: localPlayer.id,
        penaltyPoints: WRONG_GUESS_POINTS,
      });
      setStatus(
        `Wrong guess. -${WRONG_GUESS_POINTS} pts.`
      );
      return;
    }

    const claimElapsedMs =
      performance.now() - roundStartRef.current;
    const existingFieldClaim = session.currentRound.claims.find((claim) => claim.field === field);

    if (existingFieldClaim && claimElapsedMs >= existingFieldClaim.elapsedMs) {
      console.debug("[Songle quiz] claim rejected because field already faster", {
        field,
        guess,
        claimElapsedMs,
        existingFieldClaim,
      });
      setStatus(`${field === "song" ? "Song" : "Artist"} was already guessed.`);
      return;
    }

    setCorrectGuessField(field);
    setTimeout(() => setCorrectGuessField(""), 1200);
    pushUiEvent(`${field === "song" ? "Song" : "Artist"} guessed correctly.`);

    const claim = {
      type: "round:claim",
      roundId: session.currentRound.id,
      playerId: localPlayer.id,
      playerName: localPlayer.name,
      field,
      elapsedMs: claimElapsedMs,
      penaltyMs: 0,
      guessText: guess,
      trackId: currentTrack.id,
    };

    if (field === "song" && !hasArtistClaim && !artistFieldClosed) {
      setArtistGuess("");
      setTimeout(() => artistGuessPickerRef.current?.open(), 0);
    }

    if (field === "artist" && !hasSongClaim && !songFieldClosed) {
      setSongGuess("");
      setTimeout(() => songGuessPickerRef.current?.open(), 0);
    }

    if (field === "song") {
      setSongGuess("");
    } else {
      setArtistGuess("");
    }

    if (!isHost) {
      console.debug("[Songle quiz] sending claim to host", claim);
      sendSessionMessage({
        type: "session:claim",
        reliable: true,
        claim,
      });
      setStatus(`${field === "song" ? "Song" : "Artist"} claim sent to host.`);
      return;
    }

    console.debug("[Songle quiz] applying local host claim", claim);
    applyHostClaim(claim);
  };

  const handleHostPlaybackState = (nextState) => {
    hostPlaybackRuntimeRef.current = {
      ...hostPlaybackRuntimeRef.current,
      player: nextState.player || hostPlaybackRuntimeRef.current?.player,
      getCurrentState: nextState.getCurrentState || hostPlaybackRuntimeRef.current?.getCurrentState,
      activateElement: nextState.activateElement || hostPlaybackRuntimeRef.current?.activateElement,
    };
    hostPlaybackStateRef.current = {
      ...hostPlaybackStateRef.current,
      ...nextState,
    };

    if (nextState.ready === false && isHostRef.current) {
      setPlayerInfo((previousInfo) =>
        previousInfo
          ? {
              ...previousInfo,
              ready: false,
              error: nextState.lastError || previousInfo.error,
            }
          : previousInfo
      );
    }
  };

  const playerIsReadyHandler = (playerID) => {
    setPlayerInfo({
      id: playerID,
      ready: true,
    });
  };

  const logout = () => {
    Cookies.remove("spotify_access_token");
    Cookies.remove("spotify_refresh_token");
    Cookies.remove("spotify_expires_in");
    Cookies.remove("spotify_expires");
    window.location.assign("/");
  };

  const InfoTooltip = ({ label, mark = "?" }) => (
    <Tooltip>
      <TooltipTrigger>
        <button
          type="button"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center bg-transparent p-0 text-xs font-bold leading-none opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
        >
          {mark}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        className="min-w-48 max-w-64 rounded-none border-4 border-foreground bg-background px-3 py-2 text-xs leading-relaxed text-foreground shadow-none dark:border-ring"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );

  const sessionPanel = (
    <div className="flex min-w-0 flex-col gap-6">
      <Card className="songle-card-frame songle-card-side">
          <CardHeader>
            <CardTitle className="text-2xl">Session</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {roomId && (
              <div className="songle-inner-panel grid gap-2 p-3 text-sm">
                <div className="grid min-w-0 gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-3">
                  <span className="shrink-0 font-bold">Host</span>
                  <div className="flex min-w-0 items-center gap-2 sm:justify-end">
                    <span className="min-w-0 truncate sm:text-right">{hostDisplayName}</span>
                    <InfoTooltip label="The host keeps the shared room state and starts playlist changes after a vote passes." />
                  </div>
                </div>
                <div className="grid min-w-0 gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start sm:gap-3">
                  <span className="shrink-0 font-bold">Room</span>
                  <div className="flex min-w-0 items-start gap-2 sm:justify-end">
                    <span className="min-w-0 break-all sm:text-right">{roomId}</span>
                    <InfoTooltip label="Share this room ID or use the invite link to let friends join this session." />
                  </div>
                </div>
              </div>
            )}
            {(playlistName || catalog) && (
              <div className="songle-inner-panel relative overflow-hidden p-3 text-sm">
                {playlistNotice && (
                  <div className="songle-context-overlay absolute inset-0 z-10 grid place-items-center bg-background/95 p-3 text-center font-bold">
                    {playlistNotice}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Music2 className="h-4 w-4" />
                  <p className="font-bold">Current Playlist</p>
                </div>
                <p className="mt-2 min-w-0 break-words">{playlistName || catalog?.playlistName || "Songle"}</p>
              </div>
            )}
            {session && playlistVoteOptions.length > 0 && (
              <div className="songle-inner-panel min-w-0 p-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <Vote className="h-4 w-4 shrink-0" />
                  <p className="min-w-0 truncate font-bold">Playlist Vote</p>
                  <div className="ml-auto">
                    <InfoTooltip label="Playlist votes can be started between rounds before everyone is ready." />
                  </div>
                </div>
                <Select
                  value={selectedPlaylistVote?.id || ""}
                  disabled={Boolean(activeVote) || isLoadingCatalog}
                  onValueChange={setPlaylistVoteId}
                >
                  <div className="mt-3 min-w-0">
                    <SelectTrigger className="w-full min-w-0">
                      <SelectValue placeholder="Choose playlist" />
                    </SelectTrigger>
                  </div>
                  <SelectContent>
                    {playlistVoteOptions.map((playlist) => (
                      <SelectItem key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  className="mt-3 w-full"
                  onClick={() => requestPlaylistChange(selectedPlaylistVote)}
                  disabled={
                    !selectedPlaylistVote ||
                    Boolean(activeVote) ||
                    isLoadingCatalog ||
                    (phase !== "lobby" && phase !== "round-ended") ||
                    allReady
                  }
                >
                  Start Playlist Vote
                </Button>
              </div>
            )}
            {activeVote && voteCount && (
              <div className="songle-inner-panel min-w-0 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Vote className="h-4 w-4 shrink-0" />
                  <p className="min-w-0 break-words font-bold">
                    {activeVote.type === "kick"
                      ? `Remove ${activeVote.targetPlayerName}`
                      : `Change to ${activeVote.playlist.name}`}
                  </p>
                  <div className="ml-auto">
                    <InfoTooltip
                      mark="!"
                      label={
                        activeVote.type === "kick"
                          ? "The player being voted on is counted as a no vote."
                          : "A majority of active players is needed to change playlists."
                      }
                    />
                  </div>
                </div>
                <p className="mt-2">Yes {voteCount.yesVotes}/{voteCount.totalVotes}</p>
                <div className="mt-3 flex gap-2">
                  <Button
                    onClick={() => castVote(true)}
                    disabled={
                      localVote === true ||
                      (activeVote.type === "kick" && activeVote.targetPlayerId === localPlayer?.id)
                    }
                  >
                    Yes
                  </Button>
                  <Button onClick={() => castVote(false)} disabled={localVote === false}>
                    No
                  </Button>
                </div>
              </div>
            )}
            {session && (
              <Button onClick={copyInviteLink}>
                {hasCopiedInvite ? "Copied" : "Invite Friends - Copy Link"}
              </Button>
            )}
            {signalStatus && <p className="text-sm">{signalStatus}</p>}
          </CardContent>
        </Card>
    </div>
  );

  const playersPanel = (
    <div className="flex min-w-0 flex-col gap-6">
      {session && (
        <Card className="songle-card-frame songle-card-side">
          <CardHeader>
            <CardTitle className="text-2xl">Players</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {activePlayers.length > 0 && (
                <li className="grid grid-cols-[minmax(0,1fr)_52px_32px] items-center gap-2 px-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  <span>Player</span>
                  <span className="text-center">Ready</span>
                  <span />
                </li>
              )}
              {activePlayers.map((player) => (
                <li
                  key={player.id}
                  className={`songle-row-frame grid grid-cols-[minmax(0,1fr)_52px_32px] items-center gap-2 p-3 ${
                    highlightedPlayers[player.id] ? "songle-flash-row" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold">
                      {player.name} {player.id === hostPeerId ? "(host)" : ""}
                    </p>
                    <p className="text-sm">
                      {connectedPeerIds.includes(player.id) || player.id === peerId
                        ? "online"
                        : "joined"}
                      {(player.joinRoundNumber || 1) > (session.rounds.length + 1)
                        ? " - next round"
                        : ""}
                    </p>
                  </div>
                  <div className="flex h-9 w-11 items-center justify-center justify-self-center">
                    {player.ready ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-600" />
                    )}
                  </div>
                  <div className="flex justify-center">
                    {player.id !== peerId ? (
                      <Button
                        className="h-8 w-8 p-0 opacity-60 hover:opacity-100"
                        onClick={() => startKickVote(player)}
                        disabled={Boolean(activeVote)}
                        title="Start kick vote"
                      >
                        <UserX className="h-4 w-4" />
                      </Button>
                    ) : (
                      <span className="h-8 w-8" />
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {inactivePlayers.length > 0 && (
              <div className="songle-inner-panel mt-4 p-3 text-sm">
                <p className="font-bold">Left Session</p>
                <ul className="mt-2 flex flex-col gap-1">
                  {inactivePlayers.map((player) => (
                    <li key={player.id} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate">{player.name}</span>
                      <span className="shrink-0">left</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {session && (
        <Card className="songle-card-frame songle-card-side">
          <CardHeader>
            <CardTitle className="text-2xl">Leaderboard</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2">
              {[...activePlayers]
                .sort((a, b) => (session.scores[b.id] || 0) - (session.scores[a.id] || 0))
                .map((player, index) => (
                  <li
                    key={player.id}
                    className="songle-row-frame flex items-center justify-between p-3"
                  >
                    <span className="min-w-0 truncate">
                      {index + 1}. {player.name}
                    </span>
                    <span
                        className={`songle-score-pill ml-3 w-20 shrink-0 p-2 text-right ${
                        highlightedScores[player.id] ? "songle-score-pop" : ""
                      }`}
                    >
                      {session.scores[player.id] || 0} pts
                    </span>
                  </li>
                ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );

  const sidePanel = (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2 lg:items-start">
      {sessionPanel}
      {playersPanel}
    </div>
  );

  const previousRoundsPanel = session && (
    <Card className="songle-card-frame songle-card-main">
      <CardHeader>
        <CardTitle className="text-2xl">Previous Rounds</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[420px] overflow-y-auto pr-2">
          <div className="flex flex-col gap-4">
          {[...session.rounds].reverse().map((round) => (
            <div key={round.id} className="songle-inner-panel p-3">
              <h2 className="font-bold">Round {round.roundNumber}</h2>
              <ul className="mt-2 flex flex-col gap-2 text-sm">
                {round.claims.length > 0 ? (
                  round.claims.flatMap((claim) => {
                    const rows = [
                      <li
                        key={`${claim.playerId}-${claim.field}`}
                        className={`songle-row-frame grid items-center gap-2 p-2 sm:grid-cols-[minmax(0,1fr)_72px_72px] ${
                          highlightedClaims[`${round.id}-${claim.playerId}-${claim.field}`]
                            ? "songle-flash-row"
                            : ""
                        }`}
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-bold">
                            {playerNameById[claim.playerId] || claim.playerName}
                          </span>{" "}
                          guessed {claim.field}
                        </span>
                        <span className="text-right">{formatTime(claim.elapsedMs)}</span>
                        <span className="text-right">+{claim.basePoints || claim.points}</span>
                      </li>,
                    ];

                    if (claim.bonusPoints) {
                      rows.push(
                        <li
                          key={`${claim.playerId}-${claim.field}-bonus`}
                          className="songle-row-frame grid items-center gap-2 p-2 sm:grid-cols-[minmax(0,1fr)_72px_72px]"
                        >
                          <span className="min-w-0 truncate">
                            <span className="font-bold">
                              {playerNameById[claim.playerId] || claim.playerName}
                            </span>{" "}
                            completed both answers bonus
                          </span>
                          <span className="text-right">bonus</span>
                          <span className="text-right">+{claim.bonusPoints}</span>
                        </li>
                      );
                    }

                    return rows;
                  })
                ) : (
                  <li>No correct guesses yet.</li>
                )}
              </ul>
            </div>
          ))}
          {session.rounds.length === 0 && <p>No rounds played yet.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const mobileStatusPanel = (
    <div className="songle-mobile-status grid gap-3 sm:hidden">
      <div className="grid grid-cols-2 gap-3">
        <div className="songle-inner-panel min-w-0 p-3 text-center">
          <p className="text-xs font-bold uppercase text-muted-foreground">Time</p>
          <p className="mt-1 text-3xl font-bold">{formatTime(elapsedTime)}</p>
        </div>
        <div className="songle-inner-panel min-w-0 p-3 text-center">
          <p className="text-xs font-bold uppercase text-muted-foreground">Ready</p>
          <p className="mt-1 text-lg font-bold">{readySummary || "Ready 0/0"}</p>
        </div>
      </div>
      <div className="songle-inner-panel min-w-0 p-3 text-sm">
        <p className="font-bold">{phase === "round-live" ? "Round live" : phase === "countdown" ? "Starting round" : "Party Quiz"}</p>
        <p className="mt-1 break-words text-muted-foreground">{status || "Listen to the host speaker and get ready."}</p>
      </div>
    </div>
  );

  const mobileMenuButton = session && (
    <Button className="w-full xl:hidden" onClick={() => setIsMobilePanelOpen(true)}>
      Session
    </Button>
  );

  const mobileActionPanel = session && (
    <div className="grid gap-3 sm:hidden">
      <label className="songle-inner-panel flex min-h-12 w-full items-center justify-center gap-2 px-3 text-sm font-bold">
        <input
          type="checkbox"
          checked={autoReady}
          onChange={(event) => setAutoReady(event.target.checked)}
        />
        Auto-ready
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Button
          className="w-full"
          onClick={setReadyForRound}
          disabled={!canToggleReady}
        >
          {readyButtonLabel}
        </Button>
        <Button
          className="w-full"
          onClick={requestStartRound}
          disabled={
            !catalog ||
            !localPlaybackReady ||
            !allReady ||
            isRunning ||
            phase === "countdown"
          }
        >
          Start
        </Button>
      </div>
      {isHost && session?.currentRound && phase === "countdown" && !isRunning && (
        <div className="grid gap-3">
          <Button className="w-full" onClick={retryHostPlayback} disabled={!localPlaybackReady}>
            Retry Host Playback
          </Button>
          <Button className="w-full" onClick={recoverHostPlayback}>
            Mark Live If Audible
          </Button>
        </div>
      )}
      {mobileMenuButton}
    </div>
  );

  const partySetupPanel = !session && (
    <div className="songle-party-setup grid min-w-0 gap-4">
      <label className="flex min-w-0 flex-col gap-2 text-sm font-bold">
        Display Name
        <input
          className="min-w-0 w-full border px-3 py-2 font-normal"
          value={hostName}
          onChange={(event) => {
            const nextName = event.target.value;
            setHostName(nextName);
            localStorage.setItem("songle-party-display-name", nextName);
          }}
          placeholder="Your name"
        />
      </label>

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <section className="songle-inner-panel grid min-w-0 gap-3 p-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold">Join Room</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter the room ID from the host.
            </p>
          </div>
          <form
            className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              joinRoom();
            }}
          >
            <input
              className="min-w-0 w-full border px-3 py-2"
              value={joinRoomId}
              onChange={(event) => setJoinRoomId(event.target.value)}
              placeholder="Room ID"
            />
            <Button className="w-full sm:w-auto">Join Room</Button>
          </form>
        </section>

        <section className="songle-inner-panel grid min-w-0 gap-3 p-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold">Create Room</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Host the speaker playback from this device.
            </p>
          </div>
          {PLAYLIST_OPTIONS.length > 1 && (
            <Select
              value={playlistId}
              disabled={!isLoggedIn}
              onValueChange={setPlaylistId}
            >
              <SelectTrigger className="w-full min-w-0">
                <SelectValue placeholder="Choose playlist" />
              </SelectTrigger>
              <SelectContent>
                {PLAYLIST_OPTIONS.map((playlist) => (
                  <SelectItem key={playlist.id} value={playlist.id}>
                    {playlist.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            className="w-full"
            onClick={fetchCatalog}
            disabled={isLoadingCatalog || !playlistId || !isLoggedIn}
          >
            {isLoadingCatalog ? "Loading..." : "Create Room"}
          </Button>
          {!isLoggedIn && (
            <Button
              className="w-full"
              onClick={() => window.location.assign(`/api/login?next=${encodeURIComponent(PARTY_QUIZ_PATH)}`)}
            >
              Spotify Login
            </Button>
          )}
        </section>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={250}>
    <SiteShell userData={userData} onLogout={logout}>
    <main className="px-3 py-4 sm:p-10">
      <div className="mx-auto flex w-full max-w-[1800px] min-w-0 flex-col gap-4 sm:gap-6">
        {uiEvents.length > 0 && (
          <div className="fixed right-4 top-4 z-50 flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2">
            {uiEvents.map((event) => (
              <div key={event.id} className="songle-toast border bg-background p-3 text-sm shadow-lg">
                {event.text}
              </div>
            ))}
          </div>
        )}

        <section className="grid min-w-0 gap-4 sm:gap-6 xl:grid-cols-[minmax(280px,0.72fr)_minmax(620px,1.35fr)_minmax(300px,0.78fr)]">
          <div className="hidden xl:block">{playersPanel}</div>
          <div className="flex min-w-0 flex-col gap-6">
            <Card className={`songle-party-main-card songle-card-frame songle-card-main relative min-w-0 overflow-hidden ${isRoundCompleteEffect ? "songle-round-complete" : ""}`}>
              {phase === "countdown" && (isSynchronizingRound || countdownValue) && (
                <div className="absolute inset-0 z-20 grid place-items-center bg-background/75 backdrop-blur-sm">
                  <div className="songle-card-frame grid min-h-48 min-w-64 place-items-center bg-background px-10 py-8 text-center">
      {countdownValue ? (
                      <div>
                        <p className="text-sm font-bold uppercase">Round starts in</p>
                        <p className="mt-4 text-7xl font-bold">{countdownValue}</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-5">
                        <Spinner variant="diamond" className="size-16" />
                        <p className="text-sm font-bold uppercase">Synchronizing players</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <CardHeader className="px-4 py-4 sm:px-6">
                <CardTitle className="text-xl sm:text-2xl">Party Quiz</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {isHost
                    ? "This device plays the music. Everyone, including you, guesses from the same countdown."
                    : "Listen to the host speaker, then guess from this device when the countdown ends."}
                </p>
              </CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-4 px-4 pb-4 sm:gap-5 sm:px-6 sm:pb-6">
                {partySetupPanel}

                {catalog && isHost && (
                  <Player
                    token={token}
                    isReady={playerIsReadyHandler}
                    onPlaybackState={handleHostPlaybackState}
                    stopPlaying={stopPlaying}
                    stopPlaybackRequest={stopPlaybackRequest}
                  />
                )}

                {session && mobileStatusPanel}
                {mobileActionPanel}

                <div className="hidden items-stretch gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(128px,1fr))]">
                  <label className="songle-inner-panel flex min-h-12 items-center justify-center gap-2 px-3 text-sm font-bold">
                    <input
                      type="checkbox"
                      checked={autoReady}
                      onChange={(event) => setAutoReady(event.target.checked)}
                    />
                    Auto-ready
                  </label>
                  <Button
                    onClick={setReadyForRound}
                    disabled={!canToggleReady}
                  >
                    {readyButtonLabel}
                  </Button>
                  <Button
                    onClick={requestStartRound}
                    disabled={
                      !catalog ||
                      !localPlaybackReady ||
                      !allReady ||
                      isRunning ||
                      phase === "countdown"
                    }
                  >
                    Start Round
                  </Button>
                  {session && (
                    <Button
                      className="xl:hidden"
                      onClick={() => setIsMobilePanelOpen(true)}
                    >
                      Session
                    </Button>
                  )}
                  {isHost && session?.currentRound && phase === "countdown" && !isRunning && (
                    <>
                      <Button onClick={retryHostPlayback} disabled={!localPlaybackReady}>
                        Retry Host Playback
                      </Button>
                      <Button onClick={recoverHostPlayback}>
                        Mark Live If Audible
                      </Button>
                    </>
                  )}
                  <div className="songle-inner-panel flex min-h-12 items-center justify-center px-3">
                    <span className="text-3xl font-bold">{formatTime(elapsedTime)}</span>
                  </div>
                  <div className="songle-inner-panel flex min-h-12 items-center justify-center px-3 text-center font-bold">
                    {readySummary || "Ready 0/0"}
                  </div>
                </div>

                {currentTrack && (
                  <div className="grid min-w-0 gap-4 md:grid-cols-2">
                    <div
                      className={`songle-guess-panel relative min-w-0 p-3 ${
                        songSolved ? "songle-solved-song" : ""
                      } ${correctGuessField === "song" ? "songle-correct-guess" : ""}`}
                    >
                      <QuizGuessPicker
                        ref={songGuessPickerRef}
                        label="Song"
                        placeholder="Search for a song"
                        options={songNames}
                        value={songFieldClosed ? correctSongDisplay : songGuess}
                        disabled={!isRunning || hasSongClaim || songFieldClosed}
                        isError={wrongGuessField === "song"}
                        onChange={setSongGuess}
                        onSubmit={(nextGuess) => submitClaim("song", nextGuess || songGuess)}
                      />
                      {songSolved && (
                        <div className="songle-solved-note mt-3 px-3 py-2 text-sm">
                          <p className="font-bold">Song guessed</p>
                          <p className="truncate">
                            {songClaim.playerName} at {formatTime(songClaim.elapsedMs)}
                          </p>
                        </div>
                      )}
                    </div>
                    <div
                      className={`songle-guess-panel relative min-w-0 p-3 ${
                        artistSolved ? "songle-solved-artist" : ""
                      } ${correctGuessField === "artist" ? "songle-correct-guess" : ""}`}
                    >
                      <QuizGuessPicker
                        ref={artistGuessPickerRef}
                        label="Artist"
                        placeholder="Search for an artist"
                        options={artistNames}
                        value={artistFieldClosed ? correctArtistDisplay : artistGuess}
                        disabled={!isRunning || hasArtistClaim || artistFieldClosed}
                        isError={wrongGuessField === "artist"}
                        onChange={setArtistGuess}
                        onSubmit={(nextGuess) => submitClaim("artist", nextGuess || artistGuess)}
                      />
                      {artistSolved && (
                        <div className="songle-solved-note songle-solved-note-soft mt-3 px-3 py-2 text-sm">
                          <p className="font-bold">Artist guessed</p>
                          <p className="truncate">
                            {artistClaim.playerName} at {formatTime(artistClaim.elapsedMs)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="min-h-6">{status}</div>
              </CardContent>
            </Card>

            <div className="hidden sm:block">{previousRoundsPanel}</div>
          </div>

          <div className="hidden xl:block">{sessionPanel}</div>
        </section>
        {isMobilePanelOpen && (
          <div className="fixed inset-0 z-50 xl:hidden">
            <button
              type="button"
              aria-label="Close session menu"
              className="absolute inset-0 bg-black/50"
              onClick={() => setIsMobilePanelOpen(false)}
            />
            <aside className="absolute right-0 top-0 h-full w-full max-w-[420px] overflow-x-hidden overflow-y-auto border-l bg-background p-3 shadow-xl sm:p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-xl font-bold">Session</h2>
                <Button onClick={() => setIsMobilePanelOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {sidePanel}
              {previousRoundsPanel && (
                <div className="mt-6 sm:hidden">{previousRoundsPanel}</div>
              )}
            </aside>
          </div>
        )}
      </div>
    </main>
    </SiteShell>
    </TooltipProvider>
  );
}
