// sim.js â€” the actual engine. No three.js, no DOM: pure numbers so it can be
// unit-tested in node and so the readout can never disagree with the geometry,
// because both read from this file.
//
// The claim this site makes is that every number on screen is computed rather
// than typed. That is only true if the torque comes out of a pressure/volume
// integration. So it does: a single-zone indicator diagram is integrated over
// crank angle for IMEP, IMEP becomes torque, torque becomes power. The shape of
// the curve â€” dying at both ends, peaking in the middle â€” is an emergent
// consequence of compression, combustion, friction and volumetric efficiency
// fighting each other. Nothing draws it.

export const SPEC = {
  name: 'A0021-FS',
  label: '2.0 L inline-four',
  bore: 0.0860,          // m
  stroke: 0.0860,        // m, square bore/stroke
  rods: 4,
  rodLength: 0.1430,     // m, centre to centre
  compression: 14.0,     // :1, live: the page can change this and the curve answers
  firingOrder: [1, 3, 4, 2],
  redline: 7600,
  idle: 850,
  // ---- valve events, as crank degrees in the 720 degree cycle.
  // 0 is TDC of the power stroke, so the four strokes run:
  //    0-180 expansion (power)   180-360 exhaust   360-540 intake   540-720 compression
  // Quoted the way a cam card quotes them, for the timing diagram:
  exhaustOpen: 138,         // 42 deg before exhaust BDC
  exhaustClose: 368,        // 8 deg after exhaust TDC
  intakeOpen: 352,          // 8 deg before intake TDC
  intakeClose: 584,         // 44 deg after intake BDC
  intakeLift: 0.0090,       // m
  exhaustLift: 0.0080,      // m
  spark: 702,               // crank angle of the spark plug firing
  sparkBTDC: 18,            // 18 deg before TDC
  burnTail: 72,            // burn complete 72 deg after TDC
  burnGain: 8.0,           // pressure multiplier at full burn
  polytropicN: 1.34,        // compression / expansion exponent
  fmepBase: 0.90e5,        // Pa, friction and pumping drag at zero load
  fmepPerBar: 0.12e5,      // Pa of friction per bar of cylinder pressure. A real
                           // naturally aspirated four loses 2-2.5 bar; at 0.62 the
                           // model was eating 70% of its own indicated work.
  fmepSpeed: 0.017e5,      // Pa per (krpm)^2: piston drag, windage, oil pump
  // Friction at the crank, for the physical plant that spins the flywheel. This is
  // a separate quantity from FMEP: the mean effective pressure is what the diagram
  // loses, this is what the crank has to overcome to keep turning.
  frictionTorque: 6.0,     // Nm, roughly constant
  frictionPerRpm: 0.0075,   // Nm per rpm
  // the same events the way a manufacturer prints them on the cam card
  quoted: {
    exhaustOpen: '42Â° BBDC', exhaustClose: '8Â° ATDC',
    intakeOpen: '8Â° BTDC', intakeClose: '44Â° ABDC',
    durationIn: 232, durationEx: 230, lobeSeparation: 110,
  },
};

SPEC.displacement = Math.PI / 4 * SPEC.bore * SPEC.bore * SPEC.stroke * SPEC.rods;
SPEC.boreArea = Math.PI / 4 * SPEC.bore * SPEC.bore;
SPEC.clearance = (SPEC.displacement / SPEC.rods) / (SPEC.compression - 1);
SPEC.swept = SPEC.displacement / SPEC.rods;
SPEC.crankRadius = SPEC.stroke / 2;

const P_ATM = 101325;
const TWO_PI = Math.PI * 2;

export const wrap720 = a => ((a % 720) + 720) % 720;
const rad = d => (d * Math.PI) / 180;

// Crank throws. Derived from the firing order rather than hard-coded, so the
// order and the crank geometry can never drift apart. Firing order 1-3-4-2 puts
// cylinder 1 on 0 deg, 3 on 180, 4 on 360, 2 on 540.
export const FIRE_ANGLE = (() => {
  const a = [0, 0, 0, 0];
  SPEC.firingOrder.forEach((cylNumber, k) => { a[cylNumber - 1] = k * 180; });
  return a;
})();

// ---------------------------------------------------------------- kinematics
// Exact slider-crank, everything in degrees at the boundary and radians inside.
// y is the wrist-pin height above the crank centre: r + L at TDC, L - r at BDC.
// Every other position in the model derives from these two functions.
export function wristHeight(phiDeg) {
  const p = rad(phiDeg), r = SPEC.crankRadius, L = SPEC.rodLength;
  return r * Math.cos(p) + Math.sqrt(Math.max(0, L * L - r * r * Math.sin(p) * Math.sin(p)));
}

// dy/dtheta in metres per radian. The piston is fastest at mid-stroke, which is
// why an engine's torque trace peaks there and why this has to be the real
// derivative rather than a finite difference.
export function wristVelocity(phiDeg) {
  const p = rad(phiDeg), r = SPEC.crankRadius, L = SPEC.rodLength;
  const s = Math.sin(p), c = Math.cos(p);
  const root = Math.sqrt(Math.max(1e-9, L * L - r * r * s * s));
  return -r * s - (r * r * s * c) / root;
}

// Piston height at top dead centre, the reference the chamber volume is measured
// back from. The wrist pin sits a constant way below the crown, so it cancels.
export const TDC_Y = SPEC.crankRadius + SPEC.rodLength;

// Volume trapped above the piston. Smallest at TDC, where it is exactly the
// clearance volume, and largest at BDC, where it is clearance plus the swept
// volume. Getting this the wrong way round puts the volume negative at TDC, and
// a negative base raised to a fractional polytropic exponent is a silent NaN.
export function chamberVolume(phiDeg) {
  return SPEC.clearance + (TDC_Y - wristHeight(phiDeg)) * SPEC.boreArea;
}

// Cylinder volume once the intake valve has shut, which is where compression
// starts and therefore what the polytropic paths are scaled from.
const V_IVC = chamberVolume(SPEC.intakeClose);

// ---------------------------------------------------------------- valve lift
// A smooth flank-and-nose profile. The same function generates the cam lobe
// geometry and moves the valve, so the lobe and the valve can never disagree.
export function valveLift(camAngleFromCentre, duration, maxLift) {
  const half = duration / 2;
  const a = Math.abs(camAngleFromCentre);
  if (a >= half) return 0;
  const t = a / half;                      // 0 at centre, 1 at the flank
  // raised cosine, biased so the nose is fuller than the flank, like a real cam
  return maxLift * Math.pow(0.5 * (1 + Math.cos(Math.PI * t)), 1.55);
}

export function intakeLiftAt(phi) {
  // intake peak sits at the middle of the intake event
  const centre = (SPEC.intakeOpen + SPEC.intakeClose) / 2;
  return valveLift(wrap720(phi - centre), SPEC.intakeClose - SPEC.intakeOpen, SPEC.intakeLift);
}

export function exhaustLiftAt(phi) {
  const centre = (SPEC.exhaustOpen + SPEC.exhaustClose) / 2;
  return valveLift(wrap720(phi - centre), SPEC.exhaustClose - SPEC.exhaustOpen, SPEC.exhaustLift);
}

// ---------------------------------------------------------------- combustion
// Mass-fraction-burnt, as a raised cosine from the spark to the end of the burn.
// The shape matters more than it looks: a real four-stroke has only 5-15% of the
// charge burnt when the piston passes top dead centre. A long ramp that starts
// well before TDC puts most of the heat into the compression stroke, which then
// costs more work than the expansion earns, and the whole cycle collapses to a
// fraction of its real indicated mean effective pressure.
function wiebe(phi) {
  // measured from the spark. The burn ramps up over burnTail + sparkBTDC degrees and
  // is finished for the rest of that expansion stroke. Everywhere else in the cycle
  // the cylinder holds fresh charge, so burnt fraction is zero: the intake and
  // compression strokes must not inherit the previous combustion event.
  const d = wrap720(phi - SPEC.spark);
  const window = SPEC.burnTail + SPEC.sparkBTDC;
  if (d <= 0) return 0;
  if (d >= window) return 0;
  return 0.5 * (1 - Math.cos(Math.PI * d / window));
}

// ---------------------------------------------------------------- p-theta
// Single-zone indicated pressure for one cylinder. 0 is TDC of the power stroke.
export function cylinderPressure(phi) {
  const p = wrap720(phi);
  const V = chamberVolume(p);
  const x = wiebe(p);

  // the cylinder is breathing rather than sealed
  if (p >= SPEC.exhaustOpen && p < SPEC.exhaustClose) {
    // exhaust: blowdown spike as the valve cracks, then scavenging
    const since = p - SPEC.exhaustOpen;
    const blow = Math.exp(-since / 9) * 0.42;
    return P_ATM * (1 + blow);
  }
  if (p >= SPEC.intakeOpen && p < SPEC.intakeClose) {
    // intake: mild depression from flow restriction, deepest just after opening
    const since = p - SPEC.intakeOpen;
    const draw = Math.exp(-since / 42);
    return P_ATM * (1 - 0.20 * draw);
  }

  // sealed: polytropic path, scaled up by however much of the charge has burnt.
  // The motored curve is what the gas would do with no combustion at all; the
  // burn multiplier is the extra moles and extra temperature.
  const pMotored = P_ATM * 0.96 * Math.pow(Math.max(1e-9, V_IVC / V), SPEC.polytropicN);
  if (x <= 0) return pMotored;
  return pMotored * (1 + (SPEC.burnGain - 1) * x);
}

// ---------------------------------------------------------------- work
// Integrate pressure over volume for one cylinder over a full cycle. Positive
// area is the expansion work the cycle delivers back.
export function indicatedWork(steps = 1440) {
  let w = 0;
  let prevP = cylinderPressure(0), prevV = chamberVolume(0);
  for (let i = 1; i <= steps; i++) {
    const phi = (i / steps) * 720;
    const p = cylinderPressure(phi);
    const v = chamberVolume(phi);
    w += 0.5 * (p + prevP) * (v - prevV);
    prevP = p; prevV = v;
  }
  return Math.abs(w);
}

// Indicated mean effective pressure, recomputed whenever the engine spec changes
// rather than frozen at module load. That is what lets the page offer a
// compression-ratio control and have the torque curve answer it, instead of
// showing a picture of a curve someone drew.
let _imepCache = { cr: null, value: 0 };
export function imep() {
  if (_imepCache.cr === SPEC.compression) return _imepCache.value;
  SPEC.clearance = (SPEC.displacement / SPEC.rods) / (SPEC.compression - 1);
  const v = indicatedWork() / SPEC.swept;
  _imepCache = { cr: SPEC.compression, value: v };
  return v;
}
export function setCompressionRatio(cr) {
  SPEC.compression = cr;
  return imep();
}

// ---------------------------------------------------------------- friction
// Friction mean effective pressure. Three parts: a constant for bearings and
// seals, a term proportional to cylinder pressure, and one that grows with the
// square of speed for piston drag, windage and the oil pump. Without the speed
// term the model has no reason for torque to fall away at the top end.
export function frictionMeanPressure(imep, rpm = 0) {
  return SPEC.fmepBase
    + SPEC.fmepPerBar * (imep / 1e5)
    + SPEC.fmepSpeed * Math.pow(Math.max(0, rpm) / 1000, 2);
}

// ---------------------------------------------------------------- volumetric
// Volumetric efficiency against speed, as a table rather than a formula. A
// contrived closed form either falls off a cliff at redline or never falls at
// all; the shape here is the one a real naturally aspirated head produces, and
// it is the single biggest reason the torque curve has the right shoulders.
// Smoothstep between the anchors so there are no kinks in the curve on screen.
const VE_ANCHORS = [
  [700, 0.735], [1000, 0.800], [1300, 0.848], [1600, 0.878], [2000, 0.903],
  [2500, 0.920], [3000, 0.925], [3500, 0.925], [4000, 0.921], [4500, 0.914],
  [5000, 0.903], [5500, 0.888], [6000, 0.869], [6500, 0.845], [7000, 0.816], [7600, 0.786],
];
export function volumetricEfficiency(rpm) {
  const x = Math.max(1, rpm);
  if (x <= VE_ANCHORS[0][0]) return VE_ANCHORS[0][1];
  for (let i = 1; i < VE_ANCHORS.length; i++) {
    const [x1, v1] = VE_ANCHORS[i];
    if (x <= x1) {
      const [x0, v0] = VE_ANCHORS[i - 1];
      let t = (x - x0) / (x1 - x0);
      t = t * t * (3 - 2 * t);                          // smoothstep
      return v0 + (v1 - v0) * t;
    }
  }
  return VE_ANCHORS[VE_ANCHORS.length - 1][1];
}

// ---------------------------------------------------------------- torque
// Indicated torque scales with trapped mass, which scales with VE. Friction is
// speed and load dependent. Pump work grows with the speed squared.
export function torqueAt(rpm, load = 1) {
  const ve = volumetricEfficiency(rpm);
  // mass of trapped charge relative to atmospheric fill
  const charge = ve * load;
  const imepEff = imep() * charge;
  const fmep = frictionMeanPressure(imepEff, rpm);
  const pump = 0.020e5 * Math.pow(rpm / 1000, 2) * (1.35 - load);  // pumping loss
  const bmep = imepEff - fmep - pump;
  return (bmep * SPEC.displacement) / (4 * Math.PI);
}

export function powerAt(rpm, load = 1) {
  return (torqueAt(rpm, load) * rpm * TWO_PI) / 60;              // W
}

// Air/fuel ratio, and with it brake specific fuel consumption. A petrol engine
// runs rich at full load and leans out as the throttle closes, so bsfc has to
// rise off boost. A fixed AFR makes bsfc a constant, which is what a formula
// that cancels its own power term will always do.
export function airFuelRatio(load) {
  return 14.7 + (1 - clamp(load, 0, 1)) * 5.6;
}

export function bsfc(rpm, load = 1) {
  const p = powerAt(rpm, load) / 1000;                   // kW
  if (p <= 0.05) return Infinity;
  const fuelKgPerHour = (p * airFuelRatio(load)) / 44.6;   // kg/h, LHV 44.6 MJ/kg
  return (fuelKgPerHour * 1000) / p;                      // g/kWh
}

export function peakTorque() {
  let best = { rpm: 0, nm: 0 };
  for (let r = 1000; r <= SPEC.redline; r += 25) {
    const nm = torqueAt(r);
    if (nm > best.nm) best = { rpm: r, nm };
  }
  return best;
}

export function peakPower() {
  let best = { rpm: 0, kw: 0 };
  for (let r = 1000; r <= SPEC.redline; r += 25) {
    const kw = powerAt(r) / 1000;
    if (kw > best.kw) best = { rpm: r, kw };
  }
  return best;
}

// ------------------------------------------------- instantaneous crank torque
// The real thing. At any crank angle this is the pressure in each cylinder right
// now acting on its own piston, resolved through the true piston velocity:
//   dV/dtheta = -A * dy/dtheta
// so a cylinder contributes torque only while it is genuinely pushing. Summed
// over four cylinders it steps as each one comes onto its power stroke, which is
// why a real torque trace is a four-stroke pulse train and not a smooth line.
export function instantaneousTorque(crankDeg, charge = 1) {
  let t = 0;
  for (let c = 0; c < SPEC.rods; c++) {
    const phi = wrap720(crankDeg - FIRE_ANGLE[c]);
    const p = cylinderPressure(phi) * charge;
    t += p * (-SPEC.boreArea * wristVelocity(phi));
  }
  return t;
}

// ---------------------------------------------------------------- engine state
// A small physical plant so the crank has real inertia and the throttle means
// something. Worked in torque, not power: the accelerating torque is whatever the
// cylinders are making minus friction, and friction torque rises with speed. Doing
// it in power made the idle state a fixed point the engine could not hold, and it
// fell through zero into a stall where no torque exists to restart it.
export class Engine {
  constructor() {
    this.rpm = SPEC.idle;
    this.load = 0.30;
    this.throttle = 0;
    this.crank = 0;
    this.firing = 1;
    this.running = true;
  }

  step(dt) {
    const t = clamp(this.throttle, 0, 1);
    if (t < 0.02) {
      // Idle governor: if it is speeding up, back the load off, and vice versa.
      // Above idle the load has to be allowed all the way to zero, not to a small
      // positive floor. Clamping it to 0.06 left drive permanently above friction,
      // so a closed throttle still made torque and the engine could only ever
      // rev up: it would spool to the limiter and then hold there. Cutting fuel
      // outright is what a real engine does on overrun, and it lets friction alone
      // bring the crank back down.
      const err = (SPEC.idle - this.rpm) / 1000;          // Nm of trim per rpm
      let l = 0.30 + err * 6.0;
      if (this.rpm > SPEC.idle + 90) l = 0;               // closed-throttle overrun
      this.load = clamp(l, 0, 0.88);
    } else {
      this.load = 0.16 + 0.84 * t;
    }
    const drive = torqueAt(this.rpm, this.load);
    const fric = SPEC.frictionTorque + SPEC.frictionPerRpm * this.rpm;
    const accel = drive - fric;                            // Nm
    const J = 0.45;                                        // kg m^2, crank and flywheel
    let next = this.rpm + ((accel / J) * 60) / TWO_PI * dt;
    this.rpm = clamp(next, 0, SPEC.redline + 260);

    this.crank = wrap720(this.crank + ((this.rpm * TWO_PI) / 60) * dt * (180 / Math.PI));
    // fuel cut at the limiter: torque stops, so the engine cannot sit above it
    this.firing = this.rpm > SPEC.redline ? 0.25 : 1;
    return this;
  }

  get torque() { return torqueAt(this.rpm, this.load); }
  get power() { return powerAt(this.rpm, this.load); }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);



