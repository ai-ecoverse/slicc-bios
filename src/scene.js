const scene = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime, uFloor, uBox, uCone, uScoop, uEyes, uSeal, uFail, uBlink, uYaw, uAz, uP, uPoke, uLight;
uniform vec2 uShift, uMouse;
uniform float uZoom;

#define PI 3.14159265
const vec3 SC = vec3(0., .56, 0.);
const float TIP = -1.05, TOP = .38;
const vec3 BC = vec3(0., -.12, 0.);
const vec3 BH = vec3(.88, 1.33, .88);
const float SLAB = -1.52;

const vec3 PINK = vec3(.98, .55, .68);
const vec3 ORANGE = vec3(1., .46, .15);
const vec3 CONE_A = vec3(1., .56, .18);
const vec3 CONE_B = vec3(.66, .22, .04);

float gId;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.); }
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.) / k1; }
float sdBoxFrame(vec3 p, vec3 b, float e) {
  p = abs(p) - b; vec3 q = abs(p + e) - e;
  return min(min(
    length(max(vec3(p.x, q.y, q.z), 0.)) + min(max(p.x, max(q.y, q.z)), 0.),
    length(max(vec3(q.x, p.y, q.z), 0.)) + min(max(q.x, max(p.y, q.z)), 0.)),
    length(max(vec3(q.x, q.y, p.z), 0.)) + min(max(q.x, max(q.y, p.z)), 0.));
}
float sdCappedCone(vec3 p, float h, float r1, float r2) {
  vec2 q = vec2(length(p.xz), p.y);
  vec2 k1 = vec2(r2, h), k2 = vec2(r2 - r1, 2. * h);
  vec2 ca = vec2(q.x - min(q.x, (q.y < 0.) ? r1 : r2), abs(q.y) - h);
  vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0., 1.);
  float s = (cb.x < 0. && ca.y < 0.) ? -1. : 1.;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

float coneCut() { return mix(TIP - .03, TOP + .03, uCone); }
float coneBody(vec3 q) { return sdCappedCone(q - vec3(0., (TIP + TOP) * .5, 0.), (TOP - TIP) * .5, .012, .37); }
float lattice(vec3 q) {
  float a = atan(q.z, q.x) / (2. * PI);
  float u = a * 14., v = q.y * 4.4;
  return min(abs(fract(u + v) - .5), abs(fract(u - v) - .5));
}

vec3 obj(vec3 p) { vec3 q = p; q.xz = rot(uYaw) * q.xz; return q; }

float scoopShape(vec3 q) {
  float d = sdEllipsoid(q - vec3(0., .03, 0.), vec3(.40, .36, .40));
  for (int i = 0; i < 7; i++) {
    float a = float(i) * .8976 + .2;
    vec3 c = vec3(cos(a) * .335, -.17 + .03 * sin(float(i) * 2.3), sin(a) * .335);
    d = smin(d, length(q - c) - .15, .07);
  }
  d = smin(d, length(q - vec3(.10, .24, .04)) - .21, .12);
  d = smin(d, length(q - vec3(-.14, .21, -.06)) - .2, .12);
  return d;
}

float scoopSDF(vec3 q) {
  float d = 1e5;
  float g = smoothstep(.0, 1., uScoop);
  float s = mix(.22, 1., g);
  if (uScoop > .02) {
    vec3 r = q - SC;
    r.y *= 1. + .14 * uPoke; r.xz *= 1. - .07 * uPoke;
    d = scoopShape(r / s) * s * min(1., uScoop / .06);
    d += (1. - min(1., uScoop / .06)) * .2;
  }
  if (uScoop > 0. && uScoop < 1.) {
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      float arrive = .08 + .9 * (fi + 1.) / 9.;
      float t = clamp((uScoop - (arrive - .32)) / .32, 0., 1.);
      if (t <= 0. || t >= 1.) continue;
      float e = t * t * (3. - 2. * t);
      float ang = fi * 2.39996 + uTime * .45 + e * 3.5;
      float R = mix(1.9, .0, e);
      vec3 pos = vec3(cos(ang) * R, mix(-.95 + .3 * mod(fi, 4.), SC.y + .08, e), sin(ang) * R);
      float rad = .12 * smoothstep(0., .15, t) * (1. - .55 * smoothstep(.7, 1., t));
      d = smin(d, length(q - pos) - rad, .12 * e + .02);
    }
  }
  return d;
}

float frameD(vec3 p) {
  if (uBox <= 0.) return 1e5;
  vec3 b = p - BC;
  float d = sdBoxFrame(b, BH, .004);
  return max(d, b.y - mix(-BH.y - .1, BH.y + .1, uBox));
}

float ghostD(vec3 q) {
  if (uCone >= 1.) return 1e5;
  float d = abs(coneBody(q));
  d = max(d, coneCut() - q.y);
  return max(d, (lattice(q) - .015) * .25);
}

float map(vec3 p) {
  gId = 0.;
  float r = 1e5;
  if (uFloor > 0.) {
    vec3 s = p - vec3(0., SLAB, 0.);
    float d = sdBox(s, vec3(1.36, .05, .98) - .04) - .04;
    d = max(d, s.x - mix(-1.5, 1.5, uFloor));
    if (d < r) { r = d; gId = 1.; }
  }
  vec3 q = obj(p);
  if (uCone > 0.) {
    float d = coneBody(q);
    if (d < .05) d += .008 * smoothstep(.07, 0., lattice(q));
    d = max(d, q.y - coneCut());
    if (d < r) { r = d; gId = 2.; }
  }
  {
    float d = scoopSDF(q);
    if (d < r) { r = d; gId = 3.; }
  }
  float open = uEyes * uBlink;
  if (open > .03 && length(q - SC) < .7) {
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -1. : 1.;
      vec3 e = SC + vec3(side * .15, .12, .325);
      float de = sdEllipsoid(q - e, vec3(.094, .094 * open + .002, .07));
      if (de < r) { r = de; gId = 4.; }
      vec3 pp = e + vec3(uMouse.x * .03, uMouse.y * .024 * open, .05);
      float dp = sdEllipsoid(q - pp, vec3(.046, .046 * open + .002, .028));
      if (dp < r) { r = dp; gId = 5.; }
    }
  }
  if (uSeal > 0.) {
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float a = uTime * (.55 + .12 * fi) + fi * 2.094;
      vec3 c = vec3(cos(a) * .74, -.55 + .32 * fi + .08 * sin(uTime * .9 + fi * 1.7), sin(a) * .74);
      float d = length(p - c) - .07 * smoothstep(0., 1., uSeal);
      if (d < r) { r = d; gId = 7. + fi; }
    }
  }
  return r;
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1, -1); const float h = .0015;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}
float shadow(vec3 ro, vec3 rd) {
  float res = 1., t = .02;
  for (int i = 0; i < 26; i++) {
    float h = map(ro + rd * t);
    res = min(res, 9. * h / t);
    t += clamp(h, .02, .25);
    if (res < .01 || t > 4.) break;
  }
  return clamp(res, 0., 1.);
}
float occlusion(vec3 p, vec3 n) {
  float o = 0., s = 1.;
  for (int i = 0; i < 5; i++) { float h = .01 + .07 * float(i); o += (h - map(p + n * h)) * s; s *= .7; }
  return clamp(1. - 1.8 * o, 0., 1.);
}

vec3 background(vec3 ro, vec3 rd) {
  float sky = clamp(rd.y * .6 + .55, 0., 1.);
  vec3 c = mix(mix(vec3(.022, .019, .034), vec3(.07, .045, .1), sky), mix(vec3(1.62, 1.55, 1.72), vec3(2.05, 2., 2.12), sky), uLight);
  vec3 toS = normalize(SC - vec3(0., .5, 0.) - ro);
  float h = max(dot(rd, toS), 0.);
  c += PINK * pow(h, 70.) * .16 * (.25 + .75 * uP) + ORANGE * pow(h, 10.) * .03 * (.25 + .75 * uP);
  float t = (SLAB - .055 - ro.y) / min(rd.y, -1e-4);
  vec3 g = ro + rd * t;
  vec2 gc = g.xz * 2.;
  vec2 f = abs(fract(gc - .5) - .5) / max(fwidth(gc), vec2(1e-4));
  float line = 1. - min(min(f.x, f.y), 1.);
  float reveal = smoothstep(uFloor * 9., uFloor * 9. - 2., length(g.xz));
  if (rd.y < 0.) c = mix(c + mix(vec3(.35, .2, .5), ORANGE, .25) * line * exp(-t * .3) * .45 * reveal, c * (1. - vec3(.25, .3, .2) * line * exp(-t * .3) * reveal), uLight);
  return c;
}

vec2 boxHit(vec3 ro, vec3 rd, out vec3 n0, out vec3 n1) {
  vec3 m = 1. / rd, o = ro - BC;
  vec3 n = m * o, k = abs(m) * BH;
  vec3 t1 = -n - k, t2 = -n + k;
  float tN = max(max(t1.x, t1.y), t1.z), tF = min(min(t2.x, t2.y), t2.z);
  n0 = -sign(rd) * step(t1.yzx, t1.xyz) * step(t1.zxy, t1.xyz);
  n1 = sign(rd) * step(t2.xyz, t2.yzx) * step(t2.xyz, t2.zxy);
  return (tN > tF || tF < 0.) ? vec2(-1.) : vec2(tN, tF);
}

vec3 glass(vec3 col, vec3 p, vec3 n, vec3 rd, float k) {
  vec3 b = p - BC;
  if (b.y > mix(-BH.y - .1, BH.y + .1, uBox)) return col;
  float fre = pow(1. - abs(dot(n, rd)), 4.);
  vec2 uv = abs(n.x) > .5 ? b.zy : abs(n.y) > .5 ? b.xz : b.xy;
  vec2 gc = fract(uv * 10.) - .5;
  float dots = smoothstep(.06, .03, length(gc));
  float front = mix(-BH.y - .4, BH.y + .4, uSeal);
  float wave = exp(-pow((b.y - front) * 5., 2.)) * step(uSeal, .999) * step(.001, uSeal);
  float a = (fre * .14 + dots * .035) * (.2 + .8 * uSeal) + wave * (.12 + dots * .8);
  vec3 tint = mix(vec3(.8, .68, 1.), vec3(1., .3, .3), uFail);
  return col * (1. - .03 * uSeal * k) + tint * a * k;
}

vec3 shade(vec3 p, vec3 rd, float id) {
  vec3 n = calcNormal(p);
  vec3 q = obj(p);
  vec3 alb = vec3(.5); vec3 emi = vec3(0.);
  float spec = .2, rough = 16., wrap = 0.;
  if (id == 1.) {
    vec3 s = p - vec3(0., SLAB, 0.);
    alb = mix(vec3(.085, .08, .11), vec3(.62, .6, .66), uLight); spec = .6; rough = 70.;
    if (n.y > .7) {
      if (s.z < -.68) alb = mix(vec3(.15, .14, .18), vec3(.48, .46, .52), uLight);
      vec2 ab = abs(s.xz - vec2(.08, -.83)) - vec2(.78, .035);
      if (length(max(ab, 0.)) + min(max(ab.x, ab.y), 0.) - .02 < 0.) alb = vec3(.23, .22, .27);
      for (int i = 0; i < 3; i++) {
        vec3 dc = i == 0 ? vec3(1., .37, .34) : i == 1 ? vec3(1., .74, .2) : vec3(.2, .8, .38);
        if (length(s.xz - vec2(-1.18 + .1 * float(i), -.83)) < .03) { alb = dc; emi = dc * .25; }
      }
      float r = length(s.xz);
      emi += PINK * exp(-r * r * 5.) * .3 * (.2 + .8 * max(uScoop, uSeal));
    }
    emi += ORANGE * 2. * exp(-abs(s.x - mix(-1.5, 1.5, uFloor)) * 40.) * (1. - step(1., uFloor));
  } else if (id == 2.) {
    float g = smoothstep(.075, 0., lattice(q));
    alb = mix(CONE_A, CONE_B, g * .85) * (.9 + .2 * hash(floor(q * 90.)));
    spec = .15; rough = 10.;
    emi = ORANGE * 2.2 * exp(-abs(q.y - coneCut()) * 45.) * (1. - step(1., uCone));
  } else if (id == 3.) {
    alb = PINK * (.85 + .15 * smoothstep(-.3, .4, q.y - SC.y));
    wrap = .5; spec = .35; rough = 22.;
  } else if (id == 4.) {
    alb = vec3(.97); spec = .9; rough = 90.; emi = vec3(.22);
  } else if (id == 5.) {
    alb = vec3(.02); spec = 1.4; rough = 140.;
  } else if (id == 7.) { alb = vec3(.6, .9, .76); wrap = .5; spec = .3;
  } else if (id == 8.) { alb = vec3(.98, .9, .66); wrap = .5; spec = .3;
  } else if (id == 9.) { alb = vec3(.55, .33, .24); wrap = .5; spec = .4; }

  vec3 L = normalize(vec3(-.6, .9, .55));
  float dif = clamp((dot(n, L) + wrap) / (1. + wrap), 0., 1.);
  float sh = dif > 0. ? shadow(p + n * .004, L) : 0.;
  vec3 H = normalize(L - rd);
  float sp = pow(clamp(dot(n, H), 0., 1.), rough) * spec;
  float fre = pow(1. - clamp(dot(n, -rd), 0., 1.), 3.);
  float occ = occlusion(p, n);
  vec3 col = alb * (vec3(1., .93, .86) * 1.5 * dif * mix(.25, 1., sh) + vec3(.33, .36, .55) * .4 * occ * (.6 + .4 * n.y));
  col += vec3(1.) * sp * sh;
  col += fre * vec3(.65, .45, .95) * .3 * occ;
  col += alb * PINK * .18 * clamp(-n.y, 0., 1.) * occ;
  col += emi;
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / uRes.y - uShift;
  vec3 ro = vec3(sin(uAz) * 5.5, .75, cos(uAz) * 5.5);
  vec3 ta = vec3(0., -.18, 0.);
  vec3 ww = normalize(ta - ro), uu = normalize(cross(ww, vec3(0, 1, 0))), vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.55 * uZoom * ww);

  float t = 1., hit = -1., gF = 0., gG = 0.;
  for (int i = 0; i < 120; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);
    float df = frameD(p);
    float dg = ghostD(obj(p));
    if (d < .001 * t) { hit = t; break; }
    float st = min(d, max(min(df, dg) * .8, .01));
    gF += exp(-df * 160.) * st;
    gG += exp(-dg * 120.) * st;
    t += st;
    if (t > 11.) break;
  }

  vec3 col = background(ro, rd);
  if (hit > 0.) {
    vec3 p = ro + rd * hit;
    map(p);
    col = mix(shade(p, rd, gId), col, 1. - exp(-.0009 * hit * hit * hit));
  }

  vec3 n0, n1;
  vec2 bt = boxHit(ro, rd, n0, n1);
  if (bt.y > 0. && (hit < 0. || bt.y < hit)) col = glass(col, ro + rd * bt.y, n1, rd, .5);
  if (bt.x > 0. && (hit < 0. || bt.x < hit)) col = glass(col, ro + rd * bt.x, n0, rd, 1.);

  vec3 frameCol = mix(mix(ORANGE, PINK, .45), vec3(1., .85, .95), .35 * uSeal);
  frameCol = mix(frameCol, vec3(1., .2, .22), uFail);
  vec3 glow = frameCol * gF * (12. + 8. * uSeal) + ORANGE * gG * 18. * smoothstep(0., .6, uBox) * (1. - uCone * uCone);
  col = mix(col + glow, mix(col, frameCol * .9, clamp(dot(glow, vec3(.4)), 0., 1.)), uLight);

  col = 1. - exp(-col * 1.15);
  col = pow(col, vec3(.4545));
  fragColor = vec4(col, 1.);
}`;

const post = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uRes, uSRes, uTexSize;
uniform float uClarity, uTime, uFail, uMotion, uLight;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float bayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.));
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[i.x + i.y * 4] + .5) / 16.;
}
vec3 samp(vec2 fc) {
  vec2 s = fc / uRes * uSRes;
  if (uSRes.x < uRes.x * .97) s = floor(s) + .5;
  return texture(uTex, clamp(s, vec2(.5), uSRes - .5) / uTexSize).rgb;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  float c = uClarity;
  if (uFail > 0.) {
    float row = floor(fc.y / uRes.y * 46.);
    float g = hash(vec2(row, floor(uTime * 7.)));
    if (g > .88) fc.x += (g - .94) * uRes.x * .14 * uFail * uMotion;
  }
  vec2 dir = (fc - .5 * uRes) / uRes.y;
  float ab = ((1. - c) * (1. - c) * 14. + 3. * uFail) * uRes.y / 900.;
  vec3 col = vec3(samp(fc + dir * ab).r, samp(fc).g, samp(fc - dir * ab).b);

  float th = bayer(floor(fc / uRes * uSRes));
  float lum = dot(col, vec3(.299, .587, .114));
  vec3 duo = mix(mix(vec3(.045, .035, .075), vec3(.66, .58, .7), uLight), mix(vec3(1., .8, .87), vec3(.97, .96, .98), uLight), step(th, smoothstep(.3, .85, lum)));
  float lv = mix(2., 20., smoothstep(.3, .85, c));
  vec3 base = mix(col, 1. - col, uLight);
  vec3 poster = floor(base * lv + th) / lv;
  poster = mix(poster, 1. - poster, uLight);
  vec3 res = mix(duo, poster, smoothstep(.14, .42, c));
  res = mix(res, mix(col, res, .5), uLight);
  vec3 soft = texture(uTex, clamp(fc / uRes * uSRes, vec2(.5), uSRes - .5) / uTexSize).rgb;
  res = mix(res, soft, uLight * (1. - smoothstep(0., .45, fc.x / uRes.x)));
  res = mix(res, col, smoothstep(.78, .97, c));

  res *= 1. - (1. - c) * .16 * (.5 + .5 * sin(fc.y * 1.5708));
  res += (hash(fc + fract(uTime * 7.) * 91.) - .5) * (.012 + .05 * (1. - c));
  vec2 v = fc / uRes - .5;
  res *= 1. - dot(v, v) * mix(.5, .12, uLight);
  res = mix(res, vec3(dot(res, vec3(.33))) * vec3(1.1, .55, .55), uFail * .55);
  fragColor = vec4(res, 1.);
}`;

const vertex = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

const scales = [0.07, 0.1, 0.14, 0.2, 0.28, 0.38, 0.52, 0.7, 1];
const uniforms = [
  'uTime',
  'uFloor',
  'uBox',
  'uCone',
  'uScoop',
  'uEyes',
  'uSeal',
  'uFail',
  'uBlink',
  'uYaw',
  'uAz',
  'uP',
  'uPoke',
  'uLight',
];

const smooth = (from, to, x) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

function stage(p) {
  return {
    uFloor: smooth(0, 0.07, p),
    uBox: smooth(0.03, 0.15, p),
    uCone: smooth(0.09, 0.5, p),
    uScoop: smooth(0.24, 0.84, p),
    uEyes: smooth(0.84, 0.91, p),
    uSeal: smooth(0.86, 0.99, p),
    uP: p,
    clarity: p ** 0.9,
  };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function compile(gl, parallel, deadline) {
  const programs = [scene, post].map((source) => {
    const program = gl.createProgram();
    for (const [type, text] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, source],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    return program;
  });
  while (
    !programs.every((program) => gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR))
  ) {
    if (gl.isContextLost()) throw new Error('GPU context lost');
    if (performance.now() > deadline) throw new Error('shader compile too slow');
    await frame();
  }
  return programs.map((program) => {
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error('shader failed to compile');
    const locations = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let index = 0; index < count; index++) {
      const { name } = gl.getActiveUniform(program, index);
      locations[name] = gl.getUniformLocation(program, name);
    }
    return { program, locations };
  });
}

function renderer(gl, canvas, [world, filter]) {
  gl.bindVertexArray(gl.createVertexArray());
  const texture = gl.createTexture();
  const buffer = gl.createFramebuffer();
  let width = 0;
  let height = 0;

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (w === width && h === height) return;
    width = canvas.width = w;
    height = canvas.height = h;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  }

  function set({ locations }, name, ...values) {
    const at = locations[name];
    if (at == null) return;
    if (values.length === 1) gl.uniform1f(at, values[0]);
    else gl.uniform2f(at, values[0], values[1]);
  }

  return (u, quality) => {
    resize();
    const level = Math.min(scales.length - 1, Math.floor(u.clarity * (scales.length - 1) + 0.001));
    const scale = Math.min(1, scales[level] * quality);
    const sw = Math.max(1, Math.round(width * scale));
    const sh = Math.max(1, Math.round(height * scale));
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(world.program);
    set(world, 'uRes', sw, sh);
    for (const name of uniforms) set(world, name, u[name]);
    set(world, 'uShift', ...u.shift);
    set(world, 'uZoom', u.zoom);
    set(world, 'uMouse', ...u.mouse);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(filter.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(filter.locations.uTex, 0);
    set(filter, 'uRes', width, height);
    set(filter, 'uSRes', sw, sh);
    set(filter, 'uTexSize', width, height);
    set(filter, 'uClarity', u.clarity);
    set(filter, 'uTime', u.uTime);
    set(filter, 'uFail', u.uFail);
    set(filter, 'uMotion', u.motion);
    set(filter, 'uLight', u.uLight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return scale;
  };
}

function reflection(ambient, canvas, card, light) {
  const context = ambient.getContext('2d', { alpha: false });
  ambient.width = 96;
  ambient.height = 60;
  return () => {
    const page = ambient.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    if (box.width >= innerWidth - 1) return 0;
    const started = performance.now();
    const sx = ambient.width / page.width;
    const sy = ambient.height / page.height;
    const x = (box.left - page.left) * sx;
    const y = (box.top - page.top) * sy;
    const w = box.width * sx;
    const h = box.height * sy;
    const veil = light.matches ? '248 247 250' : '11 9 15';
    const scrim = context.createLinearGradient(0, 0, w, 0);
    scrim.addColorStop(0, `rgb(${veil} / 0.88)`);
    scrim.addColorStop(0.3, `rgb(${veil} / 0.6)`);
    scrim.addColorStop(0.56, `rgb(${veil} / 0)`);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        context.setTransform(
          dx ? -1 : 1,
          0,
          0,
          dy ? -1 : 1,
          x + dx * w + (dx ? w : 0),
          y + dy * h + (dy ? h : 0)
        );
        context.drawImage(canvas, 0, 0, w, h);
        context.fillStyle = scrim;
        context.fillRect(0, 0, w, h);
      }
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    return performance.now() - started;
  };
}

function eyes(card) {
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, seen: -1e4 };
  const blink = { next: performance.now() + 2500, start: -1e4 };
  let poke = -1e4;
  addEventListener('pointermove', (event) => {
    const box = card.getBoundingClientRect();
    pointer.tx = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1.3));
    pointer.ty = Math.max(-1, Math.min(1, -(((event.clientY - box.top) / box.height) * 2 - 0.8)));
    pointer.seen = performance.now();
  });
  card.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, aside')) return;
    poke = performance.now();
    blink.next = poke;
  });
  return (now, dt) => {
    if (now > blink.next) {
      blink.start = now;
      blink.next = now + 2400 + Math.random() * 4200;
    }
    const bt = (now - blink.start) / 170;
    const t = now / 1000;
    const idle = now - pointer.seen > 3500;
    const follow = Math.min(1, dt / 120);
    pointer.x += ((idle ? Math.sin(t * 0.6) * 0.6 : pointer.tx) - pointer.x) * follow;
    pointer.y += ((idle ? Math.cos(t * 0.45) * 0.4 : pointer.ty) - pointer.y) * follow;
    const pt = (now - poke) / 1000;
    return {
      uBlink: bt >= 0 && bt < 1 ? Math.abs(Math.cos(bt * Math.PI)) : 1,
      uPoke: pt < 1.2 ? Math.sin(pt * 22) * Math.exp(-pt * 4.5) : 0,
      mouse: [pointer.x, pointer.y],
    };
  };
}

function budget() {
  const times = [];
  let stalls = 0;
  let average = 16;
  let quality = 1;
  let mirror = true;
  return {
    get quality() {
      return quality;
    },
    get fps() {
      return Math.round(1000 / average);
    },
    get mirror() {
      return mirror;
    },
    set mirror(value) {
      mirror = value;
    },
    slow(dt) {
      if (dt > 1000) stalls += 1;
      if (stalls >= 2) return true;
      times.push(dt);
      if (times.length < 20) return false;
      average = times.reduce((sum, time) => sum + time, 0) / times.length;
      times.length = 0;
      mirror &&= average < 24;
      if (average > 26 && quality <= 0.35) return true;
      if (average > 26) quality = Math.max(0.35, quality * 0.8);
      else if (average < 15) quality = Math.min(1, quality * 1.08);
      return false;
    },
  };
}

function camera(canvas, now) {
  const t = now / 1000;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const wide = aspect > 1.15;
  const az = 0.62 + 0.12 * Math.sin(t * 0.09);
  return {
    uTime: t,
    uAz: az,
    uYaw: az + 0.28 * Math.sin(t * 0.21) - 0.05,
    shift: wide ? [Math.min(0.42, aspect * 0.21), 0] : [0, 0.07],
    zoom: wide ? 1 : Math.max(0.5, Math.min(1, aspect * 1.25)),
    motion: 1,
  };
}

async function prepare(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('no WebGL2');
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  try {
    if (!parallel) throw new Error('no parallel shader compile');
    const draw = renderer(gl, canvas, await compile(gl, parallel, performance.now() + 4000));
    return { gl, draw };
  } catch (error) {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    throw error;
  }
}

function chores({ gl, canvas, ambient, card, running, stats }, light, frames) {
  const reflect = reflection(ambient, canvas, card, light);
  const gpu = gl.getParameter(gl.RENDERER);
  let mirrored = 0;
  let reported = -1e4;
  let shown = false;
  return (now, scale) => {
    if (!shown) running(gpu);
    shown = true;
    if (frames.mirror && now - mirrored > 100) {
      mirrored = now;
      frames.mirror = reflect() < 6;
    }
    if (now - reported > 1000) {
      reported = now;
      stats(`${frames.fps}fps, scene at ${Math.round(scale * 100)}%`);
    }
  };
}

async function loop(options) {
  const { gl, draw, canvas, card, progress, failed, ready, reduced } = options;
  const light = matchMedia('(prefers-color-scheme: light)');
  const look = eyes(card);
  const frames = budget();
  const after = chores(options, light, frames);
  let shown = 0;
  let fail = 0;
  let last = 0;
  for (;;) {
    const now = await frame();
    if (gl.isContextLost()) return 'GPU context lost';
    if (reduced.matches) return 'reduced motion';
    const dt = last ? now - last : 16;
    last = now;
    if (document.hidden) continue;
    if (frames.slow(dt)) return 'frames too slow';
    const target = progress(now);
    shown += (target - shown) * (1 - Math.exp((-dt / 1000) * (target > shown ? 2.6 : 10)));
    fail += ((failed() ? 1 : 0) - fail) * (1 - Math.exp(-dt / 250));
    const u = {
      ...stage(shown),
      ...camera(canvas, now),
      ...look(now, dt),
      uFail: fail,
      uLight: light.matches ? 1 : 0,
    };
    if (ready()) u.clarity = 1;
    after(now, draw(u, frames.quality));
  }
}

export async function start(options) {
  let prepared;
  try {
    prepared = await prepare(options.canvas);
  } catch (error) {
    return error.message;
  }
  const reason = await loop({ ...options, ...prepared });
  prepared.gl.getExtension('WEBGL_lose_context')?.loseContext();
  return reason;
}
