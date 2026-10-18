// -----------------------------------------------------------------------------
// Two consecutive readings of a station -> scene events. Pure.
//
// "Flow above X": X is one of the marks of FLOW_THRESHOLDS (the scene author
// picks it; the core only compares a trigger filter for equality). A mark
// fires once when the flow reaches it, and is re-armed only once the flow
// fell back under 95 % of it, so a flow wavering around the mark does not
// fire at every reading. Several marks crossed at once fire each.
//
// "Danger level reached": the official FOEN flood danger level (LINDAS only)
// rose to a level (2 to 5); a jump from 1 to 3 fires level 2 and level 3. A
// level fired is re-armed only once the danger level stayed under it for 30
// minutes, so a level wavering between 2 and 3 fires 3 once.
//
// Nothing fires, the state is only armed from the reading:
//   - on the first reading of a station;
//   - when the previous reading of the state is older than STALE_AFTER (a
//     gap: nobody saw the rise);
//   - when the source or the discharge unit of the station changed (the
//     values are not comparable);
//   - for the danger level, when no level is known since the last reset.
// -----------------------------------------------------------------------------

import {
  DANGER_LEVELS,
  DANGER_REARM,
  FLOW_REARM,
  FLOW_THRESHOLDS,
  SCENE_TRIGGERS,
  STALE_AFTER,
} from './constants.js';
import { labelOf, swissTime } from './model.js';

const fmt = (value, lang) => {
  const text = String(Math.round(value * 1000) / 1000);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const FIRING_LEVELS = DANGER_LEVELS.filter((l) => l >= 2);

/** A fresh trigger state. */
export const newTriggerState = () => ({
  armed: new Set(),
  danger: null,
  fired: new Set(),
  below: new Map(),
  started: false,
  lastAt: 0,
  source: null,
  unit: null,
});

/**
 * The events of a station for a new (fresh) reading, and its next state.
 *   previous  the state returned last time (newTriggerState() the first time)
 *   device    the external id of the station device (the trigger filter)
 *   source    the data source of the reading
 */
export function stationEvents(previous, reading, device, source = null) {
  const time = Number.isFinite(reading.time) ? reading.time : 0;
  const unit = reading.flowUnit ?? null;
  const reset =
    !previous.started ||
    (previous.lastAt > 0 && time - previous.lastAt > STALE_AFTER) ||
    (previous.source !== null && previous.source !== source) ||
    (previous.unit !== null && unit !== null && previous.unit !== unit);
  const base = reset ? newTriggerState() : previous;
  const state = {
    armed: new Set(base.armed),
    danger: base.danger,
    fired: new Set(base.fired),
    below: new Map(base.below),
    started: base.started,
    lastAt: time,
    source,
    unit: unit ?? base.unit,
  };
  const events = [];
  const name = labelOf(reading);
  const measuredAt = time ? swissTime(time) : null;
  const flow = reading.flow ?? null;

  if (flow !== null) {
    for (const mark of FLOW_THRESHOLDS) {
      if (!state.started) {
        if (flow < mark) {
          state.armed.add(mark);
        }
      } else if (state.armed.has(mark) && flow >= mark) {
        state.armed.delete(mark);
        events.push({
          key: SCENE_TRIGGERS.FLOW_ABOVE,
          data: {
            device,
            threshold: String(mark),
            station: reading.id,
            station_name: name,
            flow,
            measured_at: measuredAt,
            summary: `${name}: ${fmt(flow, 'en')} m³/s (above ${mark} m³/s)`,
            summary_fr: `${name} : ${fmt(flow, 'fr')} m³/s (au-dessus de ${mark} m³/s)`,
          },
        });
      } else if (!state.armed.has(mark) && flow < mark * FLOW_REARM) {
        state.armed.add(mark);
      }
    }
  }

  const danger = reading.danger ?? null;
  if (danger !== null) {
    if (!state.started || state.danger === null) {
      // Arm only: the levels already reached count as fired.
      state.fired = new Set(FIRING_LEVELS.filter((l) => l <= danger));
      state.below = new Map();
    } else {
      for (const level of FIRING_LEVELS) {
        if (danger >= level) {
          state.below.delete(level);
          if (!state.fired.has(level)) {
            state.fired.add(level);
            events.push({
              key: SCENE_TRIGGERS.DANGER_REACHED,
              data: {
                device,
                level: String(level),
                station: reading.id,
                station_name: name,
                danger_level: danger,
                previous_level: state.danger,
                flow,
                water_level: reading.level ?? null,
                measured_at: measuredAt,
                summary: `${name}: flood danger level ${danger} of 5 (was ${state.danger})`,
                summary_fr: `${name} : danger de crue de degré ${danger} sur 5 (avant : ${state.danger})`,
              },
            });
          }
        } else if (state.fired.has(level)) {
          const since = state.below.get(level) ?? time;
          state.below.set(level, since);
          if (time - since >= DANGER_REARM) {
            state.fired.delete(level);
            state.below.delete(level);
          }
        }
      }
    }
    state.danger = danger;
  }

  // Started once the station gave something to arm on.
  if (flow !== null || danger !== null) {
    state.started = true;
  }
  return { state, events };
}
