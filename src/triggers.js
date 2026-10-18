// -----------------------------------------------------------------------------
// Two consecutive readings of a station -> scene events. Pure.
//
// "Flow above X": X is one of the marks of FLOW_THRESHOLDS (the scene author
// picks it; the core only compares a trigger filter for equality). A mark
// fires once when the flow reaches it, and is re-armed only once the flow
// fell back under 95 % of it, so a flow wavering around the mark does not
// fire at every reading. Several marks crossed at once fire each.
//
// "Danger level reached": the FOEN flood danger level rose to a level (2 to
// 5); a jump from 1 to 3 fires level 2 and level 3. It fires again after the
// level went down and up again.
//
// The first reading of a station only arms (nothing fires on a start), and
// so does the first known danger level after a gap (unknown -> 3 is not a
// rise anyone saw).
// -----------------------------------------------------------------------------

import { FLOW_REARM, FLOW_THRESHOLDS, SCENE_TRIGGERS } from './constants.js';
import { labelOf, swissTime } from './model.js';

const fmt = (value, lang) => {
  const text = String(Math.round(value * 1000) / 1000);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

/** A fresh trigger state. */
export const newTriggerState = () => ({ armed: new Set(), danger: null, started: false });

/**
 * The events of a station for a new (fresh) reading, and its next state.
 *   previous  the state returned last time (newTriggerState() the first time)
 *   device    the external id of the station device (the trigger filter)
 */
export function stationEvents(previous, reading, device) {
  const state = {
    armed: new Set(previous.armed),
    danger: previous.danger,
    started: previous.started,
  };
  const events = [];
  const name = labelOf(reading);
  const measuredAt = Number.isFinite(reading.time) ? swissTime(reading.time) : null;
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
    if (state.started && state.danger !== null && danger > state.danger) {
      for (let level = Math.max(2, state.danger + 1); level <= danger; level += 1) {
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
    }
    state.danger = danger;
  }

  // Started once the station gave something to arm on.
  if (flow !== null || danger !== null) {
    state.started = true;
  }
  return { state, events };
}
