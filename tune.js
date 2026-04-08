const { readFile } = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const COUNTRIES_PATH = path.join(DATA_DIR, 'countries.json');
const DISTANCES_PATH = path.join(DATA_DIR, 'distances.json');

const DEFAULT_TOLERANCE_KM = 100;
const DEFAULT_BORDER_TOLERANCE_KM = 25;
const DEFAULT_BUCKET_KM = 100;
const DEFAULT_MAX_STEPS = 20;
const DEFAULT_COARSE_STEP = 0.1;
const DEFAULT_FINE_STEP = 0.05;
const DEFAULT_SAMPLE = 60;
const DEFAULT_TOP = 10;
const DEFAULT_DEEP_MIN = 0;
const DEFAULT_DEEP_MAX = 0.1;
const DEFAULT_DEEP_STEP = 0.001;
const DEFAULT_DEEP_LOG_EVERY = 500;
const TRIANGULATION_MIN_GUESSES = 2;
const DEFAULT_FARTHEST_WEIGHT = 0.2;

function parseArgs() {
  const args = process.argv.slice(2);
  const getValue = (flag, fallback) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return fallback;
  };
  return {
    toleranceKm: Number(getValue('--tolerance', DEFAULT_TOLERANCE_KM)),
    borderToleranceKm: Number(getValue('--border-tolerance', DEFAULT_BORDER_TOLERANCE_KM)),
    bucketKm: Number(getValue('--bucket', DEFAULT_BUCKET_KM)),
    maxSteps: Number(getValue('--max-steps', DEFAULT_MAX_STEPS)),
    coarseStep: Number(getValue('--coarse-step', DEFAULT_COARSE_STEP)),
    fineStep: Number(getValue('--fine-step', DEFAULT_FINE_STEP)),
    sampleSize: Number(getValue('--sample', DEFAULT_SAMPLE)),
    topCount: Number(getValue('--top', DEFAULT_TOP)),
    mode: getValue('--mode', 'coarse'),
    deepMin: Number(getValue('--deep-min', DEFAULT_DEEP_MIN)),
    deepMax: Number(getValue('--deep-max', DEFAULT_DEEP_MAX)),
    deepStep: Number(getValue('--deep-step', DEFAULT_DEEP_STEP)),
    deepLogEvery: Number(getValue('--deep-log-every', DEFAULT_DEEP_LOG_EVERY)),
  };
}

function normalizeValues(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-6) return values.map(() => 0);
  return values.map((value) => (value - min) / (max - min));
}

function getTriWeights(count, weights) {
  if (count < TRIANGULATION_MIN_GUESSES) return { expected: 1, triangulation: 0 };
  const triWeight = count === 2
    ? weights.w2
    : count === 3
      ? weights.w3
      : weights.w4;
  const clamped = Math.min(1, Math.max(0, triWeight));
  return { expected: 1 - clamped, triangulation: clamped };
}

function expectedRemainingSize(guessIndex, candidateIndices, bestDistance, distances, n, bucketKm, toleranceKm) {
  const threshold = bestDistance - toleranceKm;
  const counts = new Map();
  let notCloserCount = 0;

  candidateIndices.forEach((targetIndex) => {
    const d = distances[guessIndex * n + targetIndex];
    if (d < threshold) {
      const bucket = Math.round(d / bucketKm) * bucketKm;
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    } else {
      notCloserCount += 1;
    }
  });

  const total = candidateIndices.length;
  let expected = 0;
  counts.forEach((count) => {
    expected += (count * count) / total;
  });
  expected += (notCloserCount * notCloserCount) / total;
  return expected;
}

function triangulationError(guessIndex, closestGuesses, distances, n) {
  if (!closestGuesses.length) return 0;
  let total = 0;
  closestGuesses.forEach((guess) => {
    const d = distances[guessIndex * n + guess.index];
    total += Math.abs(d - guess.distanceKm);
  });
  return total / closestGuesses.length;
}

function buildOrderConstraints(guesses) {
  const constraints = [];
  for (let i = 0; i < guesses.length; i += 1) {
    for (let j = i + 1; j < guesses.length; j += 1) {
      constraints.push({ closer: guesses[i].index, farther: guesses[j].index });
    }
  }

  return { constraints };
}

function filterCandidates(allIndices, guesses, distances, n, toleranceKm, borderToleranceKm) {
  const { constraints } = buildOrderConstraints(guesses);
  return allIndices.filter((idx) => {
    for (const guess of guesses) {
      const d = distances[guess.index * n + idx];
      if (Number.isFinite(guess.distanceKm)) {
        const tolerance = guess.distanceKm === 0 ? borderToleranceKm : toleranceKm;
        if (Math.abs(d - guess.distanceKm) > tolerance) return false;
      }
    }
    for (const constraint of constraints) {
      const dCloser = distances[constraint.closer * n + idx];
      const dFarther = distances[constraint.farther * n + idx];
      if (dCloser >= dFarther) return false;
    }
    return true;
  });
}

function rankSuggestions(candidateIndices, bestDistance, distances, n, guessedSet, guesses, weights, bucketKm, toleranceKm) {
  const closestGuesses = guesses.filter((guess) => Number.isFinite(guess.distanceKm));
  const useTriangulation = closestGuesses.length >= TRIANGULATION_MIN_GUESSES;
  const weightConfig = getTriWeights(closestGuesses.length, weights);
  const farthestGuess = guesses.length > 1 ? guesses[guesses.length - 1] : null;
  const farthestWeight = farthestGuess ? DEFAULT_FARTHEST_WEIGHT : 0;

  const scores = [];
  candidateIndices.forEach((idx) => {
    if (guessedSet.has(idx)) return;
    const expected = expectedRemainingSize(idx, candidateIndices, bestDistance, distances, n, bucketKm, toleranceKm);
    let avgDistance = 0;
    candidateIndices.forEach((targetIdx) => {
      avgDistance += distances[idx * n + targetIdx];
    });
    avgDistance /= candidateIndices.length;
    const triangulation = useTriangulation
      ? triangulationError(idx, closestGuesses, distances, n)
      : null;
    const farthestDistance = farthestGuess ? distances[idx * n + farthestGuess.index] : null;
    scores.push({ index: idx, expected, avgDistance, triangulation, farthestDistance, combined: null });
  });

  const useCombined = useTriangulation || farthestWeight > 0;
  if (useCombined) {
    const expectedNorm = normalizeValues(scores.map((item) => item.expected));
    const triangulationNorm = useTriangulation
      ? normalizeValues(scores.map((item) => item.triangulation))
      : [];
    const farthestPenalty = farthestGuess
      ? normalizeValues(scores.map((item) => item.farthestDistance)).map((value) => 1 - value)
      : [];
    const weightScale = 1 - farthestWeight;
    const expectedWeight = (useTriangulation ? weightConfig.expected : 1) * weightScale;
    const triangulationWeight = (useTriangulation ? weightConfig.triangulation : 0) * weightScale;
    scores.forEach((item, idx) => {
      let combined = expectedNorm[idx] * expectedWeight;
      if (useTriangulation) combined += triangulationNorm[idx] * triangulationWeight;
      if (farthestWeight > 0) combined += farthestPenalty[idx] * farthestWeight;
      item.combined = combined;
    });
  }

  scores.sort((a, b) => {
    if (useCombined && a.combined !== b.combined) return a.combined - b.combined;
    if (a.expected !== b.expected) return a.expected - b.expected;
    if (useTriangulation && a.triangulation !== b.triangulation) return a.triangulation - b.triangulation;
    if (farthestGuess && a.farthestDistance !== b.farthestDistance) {
      return b.farthestDistance - a.farthestDistance;
    }
    return a.avgDistance - b.avgDistance;
  });
  return scores;
}

function simulateTarget(targetIndex, n, distances, weights, settings) {
  const allIndices = Array.from({ length: n }, (_, i) => i);
  let candidates = allIndices.slice();
  const guessedSet = new Set();
  const guesses = [];
  let bestDistance = Infinity;

  const applyGuess = (idx) => {
    guessedSet.add(idx);
    const distance = distances[idx * n + targetIndex];
    const isClosest = distance < bestDistance;
    if (isClosest) bestDistance = distance;
    const guess = {
      index: idx,
      actualDistance: distance,
      distanceKm: Math.round(distance),
    };
    let insertAt = guesses.findIndex((item) => item.actualDistance > distance);
    if (insertAt === -1) insertAt = guesses.length;
    guesses.splice(insertAt, 0, guess);
    bestDistance = guesses[0].actualDistance;
    if (idx === targetIndex) return true;
    candidates = filterCandidates(
      allIndices,
      guesses,
      distances,
      n,
      settings.toleranceKm,
      settings.borderToleranceKm,
    );
    return false;
  };

  for (let step = 0; step < settings.maxSteps; step += 1) {
    const ranked = rankSuggestions(
      candidates,
      bestDistance,
      distances,
      n,
      guessedSet,
      guesses,
      weights,
      settings.bucketKm,
      settings.toleranceKm,
    );
    if (!ranked.length) break;
    const nextGuess = ranked[0].index;
    if (applyGuess(nextGuess)) return guesses.length;
    if (!candidates.length) break;
  }

  return settings.maxSteps + 1;
}

function evaluateWeights(weights, targetIndices, n, distances, settings, bestAvg = Infinity) {
  let total = 0;
  for (let i = 0; i < targetIndices.length; i += 1) {
    const targetIdx = targetIndices[i];
    const guesses = simulateTarget(targetIdx, n, distances, weights, settings);
    total += guesses;

    if (bestAvg < Infinity) {
      const remaining = targetIndices.length - i - 1;
      const bestPossible = (total + remaining * 1) / targetIndices.length;
      if (bestPossible >= bestAvg) return { avg: Infinity, aborted: true };
    }
  }
  return { avg: total / targetIndices.length, aborted: false };
}

function generateGrid(step) {
  const weights = [];
  const levels = [];
  for (let v = 0; v <= 1 + 1e-9; v += step) {
    levels.push(Math.round(v * 100) / 100);
  }
  for (let i = 0; i < levels.length; i += 1) {
    for (let j = i; j < levels.length; j += 1) {
      for (let k = j; k < levels.length; k += 1) {
        weights.push({ w2: levels[i], w3: levels[j], w4: levels[k] });
      }
    }
  }
  return weights;
}

function generateRange(min, max, step) {
  const levels = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    levels.push(Math.round(v * 1000) / 1000);
  }
  return levels;
}

function generateFineGrid(base, step) {
  const values = (v) => {
    const list = [];
    for (let x = v - 0.1; x <= v + 0.1 + 1e-9; x += step) {
      if (x < 0 || x > 1) continue;
      list.push(Math.round(x * 100) / 100);
    }
    return Array.from(new Set(list)).sort((a, b) => a - b);
  };
  const w2List = values(base.w2);
  const w3List = values(base.w3);
  const w4List = values(base.w4);
  const combos = [];
  w2List.forEach((w2) => {
    w3List.forEach((w3) => {
      if (w3 < w2) return;
      w4List.forEach((w4) => {
        if (w4 < w3) return;
        combos.push({ w2, w3, w4 });
      });
    });
  });
  return combos;
}

function selectTargets(n, count) {
  if (!count || count >= n) return Array.from({ length: n }, (_, i) => i);
  const targets = [];
  const step = n / count;
  for (let i = 0; i < count; i += 1) {
    targets.push(Math.min(n - 1, Math.floor(i * step)));
  }
  return targets;
}

async function main() {
  const settings = parseArgs();
  const countries = JSON.parse(await readFile(COUNTRIES_PATH, 'utf8'));
  const distancePayload = JSON.parse(await readFile(DISTANCES_PATH, 'utf8'));
  const n = countries.length;
  if (!Array.isArray(distancePayload.matrix) || distancePayload.matrix.length !== n * n) {
    throw new Error('Distance matrix missing or mismatched. Run training with --no-export-distances disabled.');
  }
  const distances = Float64Array.from(distancePayload.matrix);

  if (settings.mode === 'deep') {
    const levels = generateRange(settings.deepMin, settings.deepMax, settings.deepStep);
    const totalCombos = Math.round((levels.length * (levels.length + 1) * (levels.length + 2)) / 6);
    console.log(`Deep sweep mode: levels=${levels.length} combos=${totalCombos}`);
    console.log(`Range ${settings.deepMin}..${settings.deepMax} step ${settings.deepStep}`);

    const targets = Array.from({ length: n }, (_, i) => i);
    let checked = 0;
    let best = { avg: Infinity, weights: null };
    const top = [];

    for (let i = 0; i < levels.length; i += 1) {
      for (let j = i; j < levels.length; j += 1) {
        for (let k = j; k < levels.length; k += 1) {
          const weights = { w2: levels[i], w3: levels[j], w4: levels[k] };
          const { avg, aborted } = evaluateWeights(weights, targets, n, distances, settings, best.avg);
          checked += 1;
          if (!aborted && avg < best.avg) {
            best = { avg, weights };
          }
          if (!aborted) {
            top.push({ avg, weights });
            top.sort((a, b) => a.avg - b.avg);
            if (top.length > settings.topCount) top.length = settings.topCount;
          }
          if (checked % settings.deepLogEvery === 0) {
            console.log(`Checked ${checked}/${totalCombos} best ${best.avg.toFixed(3)}`);
          }
        }
      }
    }

    console.log('Top deep candidates:');
    top.forEach((entry, idx) => {
      console.log(`${idx + 1}. w2=${entry.weights.w2} w3=${entry.weights.w3} w4=${entry.weights.w4} avg=${entry.avg.toFixed(3)}`);
    });
    console.log('Best weights (deep sweep):');
    console.log(JSON.stringify({ avg: Number(best.avg.toFixed(3)), weights: best.weights }, null, 2));
    return;
  }

  const coarseTargets = selectTargets(n, settings.sampleSize);
  const fullTargets = Array.from({ length: n }, (_, i) => i);

  console.log(`Tuning weights with ${n} countries. Coarse sample: ${coarseTargets.length}`);
  const coarseGrid = generateGrid(settings.coarseStep);
  console.log(`Coarse grid size: ${coarseGrid.length}`);

  let bestCoarse = Infinity;
  const coarseResults = [];

  for (let i = 0; i < coarseGrid.length; i += 1) {
    const weights = coarseGrid[i];
    const { avg } = evaluateWeights(weights, coarseTargets, n, distances, settings, Infinity);
    coarseResults.push({ weights, avg });
    if (avg < bestCoarse) bestCoarse = avg;
    if ((i + 1) % 25 === 0 || i === coarseGrid.length - 1) {
      console.log(`Coarse ${i + 1}/${coarseGrid.length} best avg ${bestCoarse.toFixed(3)}`);
    }
  }

  coarseResults.sort((a, b) => a.avg - b.avg);
  const top = coarseResults.slice(0, settings.topCount);
  console.log('Top coarse candidates:');
  top.forEach((entry, idx) => {
    console.log(`${idx + 1}. w2=${entry.weights.w2} w3=${entry.weights.w3} w4=${entry.weights.w4} avg=${entry.avg.toFixed(3)}`);
  });

  const fineCandidates = new Map();
  top.forEach((entry) => {
    generateFineGrid(entry.weights, settings.fineStep).forEach((weights) => {
      fineCandidates.set(`${weights.w2}|${weights.w3}|${weights.w4}`, weights);
    });
  });

  const fineGrid = Array.from(fineCandidates.values());
  console.log(`Fine grid size: ${fineGrid.length}`);

  let best = { avg: Infinity, weights: null };
  for (let i = 0; i < fineGrid.length; i += 1) {
    const weights = fineGrid[i];
    const { avg, aborted } = evaluateWeights(weights, fullTargets, n, distances, settings, best.avg);
    if (!aborted && avg < best.avg) {
      best = { avg, weights };
    }
    if ((i + 1) % 10 === 0 || i === fineGrid.length - 1) {
      console.log(`Fine ${i + 1}/${fineGrid.length} current best ${best.avg.toFixed(3)}`);
    }
  }

  console.log('Best weights (full sweep):');
  console.log(JSON.stringify({ avg: Number(best.avg.toFixed(3)), weights: best.weights }, null, 2));
}

main().catch((err) => {
  console.error('Tuning failed:', err.message);
  process.exit(1);
});
