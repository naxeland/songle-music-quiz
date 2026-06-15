import { generateId } from "./uuid.js";

const SONG_POINTS = 1000;
const ARTIST_POINTS = 750;
const MIN_POINTS = 100;
const BOTH_FIELDS_BONUS = 250;
const WRONG_GUESS_POINTS = 50;

export function createSession({ playlistId, catalog, hostName }) {
  return {
    id: generateId(),
    playlistId,
    catalogSnapshotId: catalog.snapshotId,
    hostName,
    players: [],
    activity: [],
    activeVote: null,
    rounds: [],
    currentRound: null,
    scores: {},
  };
}

export function createPlayer({ id, name, isHost = false }) {
  return {
    id: id || generateId(),
    name: name || "Player",
    isHost,
    connected: true,
    kicked: false,
    ready: false,
    joinRoundNumber: 1,
  };
}

export function createRound({ roundNumber, trackId, trackUri, startsAtEpoch }) {
  return {
    id: generateId(),
    roundNumber,
    trackId,
    trackUri,
    startsAtEpoch,
    claims: [],
    completedFields: {
      song: false,
      artist: false,
    },
  };
}

export function upsertPlayer(session, player) {
  const existingPlayer = session.players.find((currentPlayer) => currentPlayer.id === player.id);
  const nextPlayer = {
    ...player,
    connected: player.connected ?? true,
    kicked: player.kicked ?? false,
    joinRoundNumber: player.joinRoundNumber ?? existingPlayer?.joinRoundNumber ?? 1,
  };
  const players = existingPlayer
    ? session.players.map((currentPlayer) =>
        currentPlayer.id === player.id
          ? {
              ...currentPlayer,
              ...nextPlayer,
              kicked: currentPlayer.kicked || nextPlayer.kicked,
              connected: currentPlayer.kicked ? false : nextPlayer.connected,
              ready: currentPlayer.kicked ? false : nextPlayer.ready,
            }
          : currentPlayer
      )
    : [...session.players, nextPlayer];

  return {
    ...session,
    players,
  };
}

export function addActivity(session, text) {
  if (!text) return session;

  return {
    ...session,
    activity: [
      ...(session.activity || []),
      {
        id: generateId(),
        text,
        createdAt: Date.now(),
      },
    ].slice(-25),
  };
}

export function getActivePlayers(session) {
  const nextRoundNumber = (session.rounds?.length || 0) + 1;
  return session.players.filter(
    (player) => !player.kicked && (player.joinRoundNumber || 1) <= nextRoundNumber
  );
}

export function getRoundReadyPlayers(session) {
  const nextRoundNumber = (session.rounds?.length || 0) + 1;
  return getActivePlayers(session).filter(
    (player) => player.connected && (player.joinRoundNumber || 1) <= nextRoundNumber
  );
}

export function markPlayerLeft(session, playerId) {
  const leavingPlayer = session.players.find((player) => player.id === playerId);
  if (!leavingPlayer || !leavingPlayer.connected) return session;

  return addActivity(
    {
      ...session,
      players: session.players.map((player) =>
        player.id === playerId ? { ...player, connected: false, ready: false } : player
      ),
    },
    `${leavingPlayer.name} left the room.`
  );
}

export function markPlayerKicked(session, playerId) {
  const kickedPlayer = session.players.find((player) => player.id === playerId);
  if (!kickedPlayer) return session;

  return addActivity(
    {
      ...session,
      activeVote: null,
      players: session.players.map((player) =>
        player.id === playerId
          ? { ...player, connected: false, kicked: true, ready: false }
          : player
      ),
    },
    `${kickedPlayer.name} was removed from the session.`
  );
}

export function applyWrongGuess(session, { playerId, field, guessText }) {
  if (!session.currentRound || !playerId) return session;

  const player = session.players.find((currentPlayer) => currentPlayer.id === playerId);
  const wrongGuess = {
    id: generateId(),
    playerId,
    playerName: player?.name || "Player",
    field,
    guessText,
    points: -WRONG_GUESS_POINTS,
    createdAt: Date.now(),
  };

  return {
    ...session,
    currentRound: {
      ...session.currentRound,
      wrongGuesses: [...(session.currentRound.wrongGuesses || []), wrongGuess],
    },
    rounds: session.rounds.map((round) =>
      round.id === session.currentRound.id
        ? {
            ...round,
            wrongGuesses: [...(round.wrongGuesses || []), wrongGuess],
          }
        : round
    ),
    scores: {
      ...session.scores,
      [playerId]: (session.scores[playerId] || 0) - WRONG_GUESS_POINTS,
    },
  };
}

export function setPlayerReady(session, playerId, ready) {
  return {
    ...session,
    players: session.players.map((player) =>
      player.id === playerId ? { ...player, ready } : player
    ),
  };
}

export function resetPlayerReadiness(session) {
  return {
    ...session,
    players: session.players.map((player) => ({
      ...player,
      ready: false,
    })),
  };
}

export function allPlayersReady(session) {
  const activePlayers = getRoundReadyPlayers(session);
  return activePlayers.length > 0 && activePlayers.every((player) => player.ready);
}

export function pointsForClaim(field, elapsedMs) {
  const base = field === "song" ? SONG_POINTS : ARTIST_POINTS;
  const penalty = Math.floor(elapsedMs / 100);
  return Math.max(MIN_POINTS, base - penalty);
}

function scoreRoundClaims(claims) {
  const scoredClaims = claims.map((claim) => {
    const basePoints = pointsForClaim(claim.field, claim.elapsedMs);
    return {
      ...claim,
      basePoints,
      bonusPoints: 0,
      points: basePoints,
      submittedAt: claim.submittedAt || performance.now(),
    };
  });
  const songClaim = scoredClaims.find((claim) => claim.field === "song");
  const artistClaim = scoredClaims.find((claim) => claim.field === "artist");

  if (songClaim && artistClaim && songClaim.playerId === artistClaim.playerId) {
    const bonusClaim =
      artistClaim.elapsedMs >= songClaim.elapsedMs ? artistClaim : songClaim;
    bonusClaim.bonusPoints = BOTH_FIELDS_BONUS;
    bonusClaim.points = bonusClaim.basePoints + BOTH_FIELDS_BONUS;
  }

  return scoredClaims;
}

function scoreClaimsByPlayer(claims) {
  return claims.reduce((scores, claim) => {
    return {
      ...scores,
      [claim.playerId]: (scores[claim.playerId] || 0) + claim.points,
    };
  }, {});
}

export function applyClaim(session, claim) {
  if (!session.currentRound || session.currentRound.id !== claim.roundId) {
    return session;
  }

  const existingFieldClaim = session.currentRound.claims.find(
    (existingClaim) => existingClaim.field === claim.field
  );

  if (existingFieldClaim && claim.elapsedMs >= existingFieldClaim.elapsedMs) {
    return session;
  }

  const claimsWithoutCurrentField = session.currentRound.claims.filter(
    (existingClaim) => existingClaim.field !== claim.field
  );
  const previousRoundScores = scoreClaimsByPlayer(session.currentRound.claims);
  const nextClaims = scoreRoundClaims([
    ...claimsWithoutCurrentField,
    {
      ...claim,
      submittedAt: performance.now(),
    },
  ]);
  const nextRoundScores = scoreClaimsByPlayer(nextClaims);
  const allRoundPlayerIds = new Set([
    ...Object.keys(previousRoundScores),
    ...Object.keys(nextRoundScores),
  ]);
  const nextScores = { ...session.scores };

  allRoundPlayerIds.forEach((playerId) => {
    nextScores[playerId] =
      (nextScores[playerId] || 0) -
      (previousRoundScores[playerId] || 0) +
      (nextRoundScores[playerId] || 0);
  });

  return {
    ...session,
    currentRound: {
      ...session.currentRound,
      claims: nextClaims,
      completedFields: {
        ...session.currentRound.completedFields,
        [claim.field]: true,
      },
    },
    rounds: session.rounds.map((round) =>
      round.id === session.currentRound.id
        ? {
            ...round,
            claims: nextClaims,
            completedFields: {
              ...round.completedFields,
              [claim.field]: true,
            },
          }
        : round
    ),
    scores: nextScores,
  };
}

export function isRoundComplete(round) {
  return Boolean(round?.completedFields.song && round?.completedFields.artist);
}
