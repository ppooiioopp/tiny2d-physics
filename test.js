#!/usr/bin/env node
/**
 * Tiny2D 物理引擎测试
 * 运行：node test.js
 */
'use strict';

const Tiny2D = require('./physics.js');
const Nature = require('./nature.js');
const Fluid = require('./fluid.js');
const { Vec2, Body, World, Shapes } = Tiny2D;

// ---------------- 迷你测试框架 ----------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function approx(actual, expected, tolerance, label = '') {
  if (!Number.isFinite(actual)) {
    throw new Error(`${label} 不是有限数：${actual}`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label} 期望 ${expected} ± ${tolerance}，实际 ${actual}`
    );
  }
}

function assertFiniteBody(body, label = '') {
  const values = [
    body.position.x, body.position.y, body.angle,
    body.velocity.x, body.velocity.y, body.angularVelocity,
  ];
  for (const v of values) {
    assert(Number.isFinite(v), `${label} 出现非有限数值: ${v}`);
  }
}

function makeFloor(world, topY = 4.5, width = 20) {
  return world.addBody(
    new Body(Shapes.box(width, 1), {
      position: new Vec2(0, topY + 0.5),
      isStatic: true,
      friction: 0.5,
      restitution: 0.1,
    })
  );
}

// ---------------- 向量 ----------------

console.log('\n[向量]');

test('Vec2 基本运算', () => {
  const a = new Vec2(3, 4);
  approx(a.length(), 5, 1e-12, '长度');
  approx(a.dot(new Vec2(1, 0)), 3, 1e-12, '点积');
  approx(new Vec2(1, 0).cross(new Vec2(0, 1)), 1, 1e-12, '叉积');
  const b = new Vec2(1, 0).rotate(Math.PI / 2);
  approx(b.x, 0, 1e-12, '旋转 x');
  approx(b.y, 1, 1e-12, '旋转 y');
});

test('Vec2 normalize 零向量不产生 NaN', () => {
  const z = new Vec2(0, 0).normalize();
  assert(z.x === 0 && z.y === 0, '零向量归一化应保持 0');
});

// ---------------- 形状与质量属性 ----------------

console.log('\n[形状与质量属性]');

test('矩形质量 / 转动惯量', () => {
  const poly = Shapes.box(2, 4);
  const props = poly.computeMass(2);
  approx(props.mass, 16, 1e-12, '质量');
  approx(props.inertia, (16 * (2 * 2 + 4 * 4)) / 12, 1e-9, '转动惯量');
});

test('圆形质量 / 转动惯量', () => {
  const circle = Shapes.circle(2);
  const props = circle.computeMass(1);
  approx(props.mass, Math.PI * 4, 1e-12, '质量');
  approx(props.inertia, 0.5 * Math.PI * 4 * 4, 1e-12, '转动惯量');
});

test('多边形自动重排并质心居中', () => {
  const tri = Shapes.triangle(2, 2);
  approx(tri.centroidOffset.x, 0, 1e-9, '质心 x');
  approx(tri.centroidOffset.y, 1 / 3, 1e-9, '质心 y');
  let sumX = 0;
  let sumY = 0;
  for (const v of tri.vertices) {
    sumX += v.x;
    sumY += v.y;
  }
  approx(sumX, 0, 1e-9, '顶点 x 均值和');
  approx(sumY, 0, 1e-9, '顶点 y 均值和（质心居中后）');
});

test('变换：localToWorld / worldToLocal 互逆', () => {
  const body = new Body(Shapes.box(1, 1), { position: new Vec2(3, -2), angle: 0.7 });
  const local = new Vec2(0.25, -0.4);
  const world = body.localToWorld(local);
  const back = body.worldToLocal(world);
  approx(back.x, local.x, 1e-12, 'local.x');
  approx(back.y, local.y, 1e-12, 'local.y');
});

// ---------------- 积分与静止 ----------------

console.log('\n[积分与静止]');

test('自由落体：1 秒后的速度与位移', () => {
  const world = new World({ gravity: new Vec2(0, 9.81) });
  const body = world.addBody(new Body(Shapes.circle(0.5), { position: new Vec2(0, 0) }));
  const dt = 1 / 240;
  for (let i = 0; i < 240; i++) world.step(dt);
  approx(body.velocity.y, 9.81, 1e-6, '1 秒后竖直速度');
  // 半隐式欧拉的位移略大于 1/2 g t²
  const expected = 0.5 * 9.81 * (1 / 240) * 241;
  approx(body.position.y, expected, 1e-6, '1 秒后位移');
});

test('圆形静止在静态地板上', () => {
  const world = new World();
  makeFloor(world);
  const ball = world.addBody(
    new Body(Shapes.circle(0.5), { position: new Vec2(0, 2), restitution: 0 })
  );
  for (let i = 0; i < 240; i++) world.step(1 / 120);
  approx(ball.position.y, 4.0, 0.02, '球心 y');
  approx(ball.velocity.y, 0, 0.05, '竖直速度');
  approx(ball.velocity.x, 0, 0.02, '水平速度');
  assertFiniteBody(ball, '球');
});

test('方块静止在地板上且不倾斜', () => {
  const world = new World();
  makeFloor(world);
  const box = world.addBody(
    new Body(Shapes.box(1, 0.5), {
      position: new Vec2(0, 2),
      restitution: 0,
      angularDamping: 0.05,
    })
  );
  for (let i = 0; i < 240; i++) world.step(1 / 120);
  approx(box.position.y, 4.25, 0.02, '方块中心 y');
  approx(box.angle, 0, 0.01, '角度');
  approx(box.velocity.x, 0, 0.02, '水平速度');
  assertFiniteBody(box, '方块');
});

test('静态刚体不受重力影响', () => {
  const world = new World();
  const ground = world.addBody(
    new Body(Shapes.box(10, 1), { position: new Vec2(0, 5), isStatic: true })
  );
  for (let i = 0; i < 120; i++) world.step(1 / 120);
  approx(ground.position.x, 0, 0, 'x');
  approx(ground.position.y, 5, 0, 'y');
  approx(ground.angularVelocity, 0, 0, '角速度');
});

// ---------------- 碰撞 ----------------

console.log('\n[碰撞检测与求解]');

test('两圆接触法线与穿透量', () => {
  const world = new World({ gravity: new Vec2(0, 0) });
  world.addBody(new Body(Shapes.circle(0.5), { position: new Vec2(0, 0) }));
  world.addBody(new Body(Shapes.circle(0.5), { position: new Vec2(0.8, 0) }));
  world.step(1 / 120);
  assert(world.contacts.length === 1, `应有 1 个接触，实际 ${world.contacts.length}`);
  const contact = world.contacts[0];
  approx(contact.normal.x, 1, 1e-6, '法线 x');
  approx(contact.normal.y, 0, 1e-6, '法线 y');
  approx(contact.points[0].separation, -0.2, 1e-6, '分离量');
});

test('分离的两圆不产生接触', () => {
  const world = new World({ gravity: new Vec2(0, 0) });
  world.addBody(new Body(Shapes.circle(0.5), { position: new Vec2(0, 0) }));
  world.addBody(new Body(Shapes.circle(0.5), { position: new Vec2(2, 0) }));
  world.step(1 / 120);
  assert(world.contacts.length === 0, '不应有接触');
});

test('两球完全弹性碰撞：等质量交换速度', () => {
  const world = new World({ gravity: new Vec2(0, 0), iterations: 12 });
  const left = world.addBody(
    new Body(Shapes.circle(0.5), {
      position: new Vec2(-1.5, 0),
      velocity: new Vec2(2, 0),
      restitution: 1,
      friction: 0,
    })
  );
  const right = world.addBody(
    new Body(Shapes.circle(0.5), {
      position: new Vec2(1.5, 0),
      velocity: new Vec2(-2, 0),
      restitution: 1,
      friction: 0,
    })
  );
  const mass = left.mass;
  const momentumBefore = mass * (left.velocity.x + right.velocity.x);
  const energyBefore = 0.5 * mass * (2 * 2 + 2 * 2);
  for (let i = 0; i < 240; i++) world.step(1 / 120);

  approx(left.velocity.x, -2, 0.15, '左球速度');
  approx(right.velocity.x, 2, 0.15, '右球速度');
  const momentumAfter = mass * (left.velocity.x + right.velocity.x);
  approx(momentumAfter, momentumBefore, 1e-6, '动量守恒');
  const energyAfter = 0.5 * mass * (left.velocity.x ** 2 + left.velocity.y ** 2 + right.velocity.x ** 2 + right.velocity.y ** 2);
  approx(energyAfter, energyBefore, energyBefore * 0.08, '动能基本守恒');
});

test('方块落在静态方块上最终静止', () => {
  const world = new World();
  world.addBody(
    new Body(Shapes.box(6, 0.5), {
      position: new Vec2(0, 3),
      isStatic: true,
      restitution: 0.1,
      friction: 0.5,
    })
  );
  const box = world.addBody(
    new Body(Shapes.box(1, 0.5), {
      position: new Vec2(0, 1),
      restitution: 0,
      angularDamping: 0.05,
    })
  );
  for (let i = 0; i < 300; i++) world.step(1 / 120);
  const topY = 3 - 0.25;
  approx(box.position.y, topY - 0.25, 0.03, '方块中心 y');
  approx(box.angle, 0, 0.02, '角度');
  assertFiniteBody(box, '方块');
});

test('圆形停在矩形上（圆-多边形碰撞）', () => {
  const world = new World();
  makeFloor(world);
  const ball = world.addBody(
    new Body(Shapes.circle(0.4), { position: new Vec2(0, 1), restitution: 0 })
  );
  for (let i = 0; i < 240; i++) world.step(1 / 120);
  approx(ball.position.y, 4.5 - 0.4, 0.02, '圆心 y');
  assertFiniteBody(ball, '球');
});

test('圆在矩形内部时能被推向边界', () => {
  const world = new World();
  world.addBody(
    new Body(Shapes.box(6, 6), {
      position: new Vec2(0, 0),
      isStatic: true,
      restitution: 0,
      friction: 0,
    })
  );
  const ball = world.addBody(
    new Body(Shapes.circle(0.4), { position: new Vec2(0.5, 0), restitution: 0 })
  );
  for (let i = 0; i < 120; i++) world.step(1 / 120);
  const local = world.bodies[0].worldToLocal(ball.position);
  assert(Math.hypot(local.x, local.y) > 2.9, `圆应被推出正方形，实际 ${Math.hypot(local.x, local.y)}`);
  assertFiniteBody(ball, '球');
});

test('复位叠放方块（5 层）保持稳定', () => {
  const world = new World({ iterations: 12 });
  makeFloor(world);
  const boxes = [];
  const size = 1;
  const height = 0.5;
  for (let i = 0; i < 5; i++) {
    boxes.push(
      world.addBody(
        new Body(Shapes.box(size, height), {
          position: new Vec2(0, 4.5 - height / 2 - i * height),
          restitution: 0,
          friction: 0.6,
          angularDamping: 0.05,
        })
      )
    );
  }
  for (let i = 0; i < 600; i++) world.step(1 / 120);

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    assertFiniteBody(box, `第 ${i + 1} 层`);
    approx(box.position.x, 0, 0.12, `第 ${i + 1} 层 x 漂移`);
    approx(box.angle, 0, 0.05, `第 ${i + 1} 层倾角`);
    approx(box.position.y, 4.5 - height / 2 - i * height, 0.08, `第 ${i + 1} 层高度`);
    assert(Math.hypot(box.velocity.x, box.velocity.y) < 0.1, `第 ${i + 1} 层仍在运动`);
  }
});

test('摩擦让滑块停下来', () => {
  const world = new World();
  const floor = makeFloor(world);
  floor.friction = 0.5;
  const box = world.addBody(
    new Body(Shapes.box(1, 0.5), {
      position: new Vec2(0, 4.25),
      velocity: new Vec2(5, 0),
      restitution: 0,
      friction: 0.5,
      angularDamping: 0.2,
    })
  );
  for (let i = 0; i < 240; i++) world.step(1 / 120);
  assert(Math.abs(box.velocity.x) < 0.1, `滑块应停下，实际 vx=${box.velocity.x}`);
  assert(box.position.x > 1.5 && box.position.x < 3.5, `滑行距离异常: ${box.position.x}`);
  assertFiniteBody(box, '滑块');
});

test('弹性小球触地反弹', () => {
  const world = new World();
  makeFloor(world);
  const ball = world.addBody(
    new Body(Shapes.circle(0.3), {
      position: new Vec2(0, 1),
      restitution: 0.8,
      friction: 0,
    })
  );
  let minY = Infinity;
  for (let i = 0; i < 180; i++) {
    world.step(1 / 120);
    minY = Math.min(minY, ball.position.y);
  }
  // 下落约 3.2 m，0.8 弹性应反弹约 2 m
  assert(minY < 3.0, `反弹高度不足，最高点 y=${minY}`);
  assert(minY > 1.0, `反弹异常地高，最高点 y=${minY}`);
});

test('高速小球不会穿透厚地板', () => {
  const world = new World();
  makeFloor(world, 4.5, 20);
  const ball = world.addBody(
    new Body(Shapes.circle(0.3), {
      position: new Vec2(0, 1),
      velocity: new Vec2(0, 30),
      restitution: 0,
      friction: 0.2,
    })
  );
  for (let i = 0; i < 240; i++) world.step(1 / 120);
  assert(ball.position.y < 4.5, `球穿过了地板，y=${ball.position.y}`);
  assertFiniteBody(ball, '球');
});

test('深度重叠的方块会被推开', () => {
  const world = new World({ gravity: new Vec2(0, 0), iterations: 12 });
  const a = world.addBody(
    new Body(Shapes.box(1, 1), { position: new Vec2(0, 0), restitution: 0, friction: 0 })
  );
  const b = world.addBody(
    new Body(Shapes.box(1, 1), { position: new Vec2(0.2, 0), restitution: 0, friction: 0 })
  );
  for (let i = 0; i < 180; i++) world.step(1 / 120);
  const dist = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
  assert(dist > 0.7, `两个方块没有被推开，中心距离 ${dist}`);
  assertFiniteBody(a, '方块 A');
  assertFiniteBody(b, '方块 B');
});

test('接触流形两点接触（方块放在地板上）', () => {
  const world = new World();
  makeFloor(world);
  world.addBody(
    new Body(Shapes.box(1, 0.5), {
      position: new Vec2(0, 4.25),
      restitution: 0,
      friction: 0.5,
    })
  );
  world.step(1 / 120);
  assert(world.contacts.length === 1, `应有 1 个接触，实际 ${world.contacts.length}`);
  assert(
    world.contacts[0].points.length === 2,
    `方块与地板应有 2 个接触点，实际 ${world.contacts[0].points.length}`
  );
});

// ---------------- 自然物体形状 ----------------

console.log('\n[自然物体形状]');

function isConvexPolygon(poly) {
  const verts = poly.vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const c = verts[(i + 2) % verts.length];
    const cross =
      (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross < -1e-9) return false;
  }
  return true;
}

function polygonSize(poly) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of poly.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { width: maxX - minX, height: maxY - minY };
}

test('凸包能剔除内部点', () => {
  const hull = Nature.convexHull([
    new Vec2(0, 0),
    new Vec2(1, 0),
    new Vec2(1, 1),
    new Vec2(0, 1),
    new Vec2(0.5, 0.5),
  ]);
  assert(hull.length === 4, `凸包应剩 4 个点，实际 ${hull.length}`);
});

test('石头形状随机但始终是合法凸多边形', () => {
  for (let i = 0; i < 25; i++) {
    const rock = Nature.makeRockShape(0.4, 0.6);
    const shape = rock.shape;
    assert(shape.type === 'polygon', '石头应为多边形');
    assert(shape.vertices.length >= 3, '石头至少 3 个顶点');
    assert(isConvexPolygon(shape), '石头必须是凸多边形');
    const size = polygonSize(shape);
    assert(size.width > 0.4, `石头宽度异常: ${size.width}`);
    assert(size.height < size.width, '压扁石头的宽度应大于高度');
    const props = shape.computeMass(2.2);
    assert(props.mass > 0 && props.inertia > 0, '石头质量属性应有效');
    assert(rock.specks.length >= 2, '石头应带有表面斑点数据');
  }
});

test('原木形状尺寸正确', () => {
  const shape = Nature.makeLogShape(1.4, 0.3);
  assert(shape.type === 'polygon', '原木应为多边形');
  assert(isConvexPolygon(shape), '原木必须是凸多边形');
  const size = polygonSize(shape);
  approx(size.width, 1.4, 0.02, '原木长度');
  approx(size.height, 0.3, 0.02, '原木粗细');
});

test('树叶形状两端尖、中间宽', () => {
  const shape = Nature.makeLeafShape(0.7, 0.3);
  assert(shape.type === 'polygon', '树叶应为多边形');
  assert(shape.vertices.length === 8, '树叶应为 8 边形');
  assert(isConvexPolygon(shape), '树叶必须是凸多边形');
  const size = polygonSize(shape);
  approx(size.width, 0.7, 0.01, '叶长');
  approx(size.height, 0.3, 0.01, '叶宽');
});

test('自然形状刚体可以正常模拟', () => {
  const world = new World();
  makeFloor(world);
  const rock = world.addBody(
    new Body(Nature.makeRockShape(0.3, 0.7).shape, {
      position: new Vec2(-2, 2),
      restitution: 0.1,
      friction: 0.7,
    })
  );
  const log = world.addBody(
    new Body(Nature.makeLogShape(1.2, 0.28), {
      position: new Vec2(0, 1),
      angle: 0.2,
      restitution: 0.1,
    })
  );
  const leaf = world.addBody(
    new Body(Nature.makeLeafShape(0.6, 0.25), {
      position: new Vec2(2, 1.5),
      density: 0.3,
      linearDamping: 2.6,
    })
  );
  for (let i = 0; i < 360; i++) world.step(1 / 120);
  for (const body of [rock, log, leaf]) {
    assertFiniteBody(body, '自然物体');
    assert(body.position.y < 4.5, '自然物体不应穿过地板');
  }
});

test('扁石形状上下平整且尺寸正确', () => {
  const stone = Nature.makeFlatStoneShape(0.5, 0.34, 0.12);
  const shape = stone.shape;
  assert(shape.type === 'polygon', '扁石应为多边形');
  assert(isConvexPolygon(shape), '扁石必须是凸多边形');
  const size = polygonSize(shape);
  approx(size.width, 1.0, 0.08, '扁石宽度');
  approx(size.height, 0.34, 0.04, '扁石厚度');

  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of shape.vertices) {
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  let flatTop = 0;
  let flatBottom = 0;
  for (const v of shape.vertices) {
    if (Math.abs(v.y - minY) < 1e-6) flatTop++;
    if (Math.abs(v.y - maxY) < 1e-6) flatBottom++;
  }
  assert(flatTop >= 2 && flatBottom >= 2, '扁石应有平整的上下边');
});

test('五块扁石能稳定垒成石堆', () => {
  const world = new World();
  makeFloor(world, 4.5, 20);
  const radii = [0.52, 0.45, 0.38, 0.31, 0.24];
  let topY = 4.5;
  const stones = [];
  for (const radius of radii) {
    const thickness = radius * 2 * 0.34;
    const stone = Nature.makeFlatStoneShape(radius, thickness, 0.12);
    const body = world.addBody(
      new Body(stone.shape, {
        position: new Vec2(0, topY - thickness / 2),
        density: 2.2,
        restitution: 0,
        friction: 0.9,
        angularDamping: 0.6,
      })
    );
    body.computeAABB();
    topY = body._aabb.minY - 0.002;
    stones.push(body);
  }
  const initialHeight = 4.5 - topY;

  for (let i = 0; i < 480; i++) world.step(1 / 120);

  let minY = Infinity;
  let maxDrift = 0;
  for (const stone of stones) {
    minY = Math.min(minY, stone.position.y);
    maxDrift = Math.max(maxDrift, Math.abs(stone.position.x));
    assertFiniteBody(stone, '扁石');
  }
  const finalHeight = 4.5 - minY;
  assert(
    finalHeight > initialHeight * 0.9,
    `石堆塌了：高度 ${finalHeight.toFixed(2)} / ${initialHeight.toFixed(2)}`
  );
  assert(maxDrift < 0.1, `石堆横向漂移过大: ${maxDrift.toFixed(3)}`);
});

// ---------------- 流体 ----------------

console.log('\n[流体]');

test('粒子与圆 / 多边形刚体的碰撞检测', () => {
  const circleBody = new Body(Shapes.circle(1), { position: new Vec2(0, 0) });
  const hitCircle = Fluid.collideParticleWithBody({ x: 0.5, y: 0 }, circleBody, 0.1);
  assert(hitCircle, '圆内粒子应检测到碰撞');
  assert(hitCircle.nx > 0.99, '圆碰撞法线应指向 +x');
  approx(hitCircle.pen, 0.6, 1e-9, '圆碰撞穿透深度');

  const boxBody = new Body(Shapes.box(2, 2), { position: new Vec2(0, 0) });
  const inside = Fluid.collideParticleWithBody({ x: 0.99, y: 0 }, boxBody, 0.05);
  assert(inside && inside.nx > 0.9, '内部粒子应沿最近面推出');
  const nearby = Fluid.collideParticleWithBody({ x: 1.04, y: 0 }, boxBody, 0.05);
  assert(nearby && nearby.nx > 0.9, '边界附近粒子应检测到碰撞');
  const far = Fluid.collideParticleWithBody({ x: 2, y: 0 }, boxBody, 0.05);
  assert(far === null, '远离刚体的粒子不应碰撞');
});

test('流体粒子数量上限与发射', () => {
  const fluid = new Fluid({ maxParticles: 20 });
  fluid.emit(0, 0, 10, { spread: 0.1 });
  assert(fluid.count === 10, '应发射 10 个粒子');
  fluid.emit(0, 0, 30, { spread: 0.1 });
  assert(fluid.count === 20, '达到上限后不再添加新粒子');
});

test('流体在水箱中稳定沉降且不穿地板', () => {
  const world = new World({ gravity: new Vec2(0, 0), iterations: 1 });
  const floorTop = 4.5;
  world.addBody(new Body(Shapes.box(20, 1), {
    position: new Vec2(0, floorTop + 0.5), isStatic: true,
  }));
  world.addBody(new Body(Shapes.box(0.4, 8), {
    position: new Vec2(-2.2, floorTop - 4), isStatic: true,
  }));
  world.addBody(new Body(Shapes.box(0.4, 8), {
    position: new Vec2(2.2, floorTop - 4), isStatic: true,
  }));
  for (const b of world.bodies) b.computeAABB();

  const fluid = new Fluid({ maxParticles: 400 });
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 10; x++) {
      fluid.addParticle(-1.8 + x * 0.09, 1.0 + y * 0.09, 0, 0);
    }
  }
  const initialCount = fluid.count;
  for (let i = 0; i < 180; i++) {
    fluid.step(1 / 120, world.bodies);
    fluid.cull(-10, -10, 10, 10);
  }

  assert(fluid.count === initialCount, '水箱里的水粒子不应丢失');
  let maxY = -Infinity;
  let sumSpeed = 0;
  let sumRho = 0;
  for (const p of fluid.particles) {
    assert(Number.isFinite(p.x + p.y + p.vx + p.vy + p.rho), '流体出现非有限数值');
    maxY = Math.max(maxY, p.y);
    sumSpeed += Math.hypot(p.vx, p.vy);
    sumRho += p.rho;
  }
  assert(maxY < floorTop + 0.05, `水粒子穿过了地板：maxY=${maxY.toFixed(2)}`);
  assert(sumSpeed / fluid.count < 3, '流体长时间后应基本静止');
  const avgRho = sumRho / fluid.count;
  assert(avgRho > 1.5 && avgRho < 5, `流体平均密度异常：${avgRho.toFixed(2)}`);
});

// ---------------- 其他 ----------------

console.log('\n[其他]');

test('queryPoint 能拾取刚体', () => {
  const world = new World();
  const box = world.addBody(new Body(Shapes.box(1, 1), { position: new Vec2(2, 3) }));
  assert(world.queryPoint(new Vec2(2, 3)) === box, '应命中方块中心');
  assert(world.queryPoint(new Vec2(3, 3)) === null, '应未命中方块外部');
  assert(world.queryPoint(new Vec2(2, 3), true) === box, '包含静态体查询');
});

test('removeBody / clear 正常工作', () => {
  const world = new World();
  const a = world.addBody(new Body(Shapes.circle(1)));
  const b = world.addBody(new Body(Shapes.circle(1)));
  assert(world.bodies.length === 2, '添加后应有 2 个刚体');
  world.removeBody(a);
  assert(world.bodies.length === 1 && world.bodies[0] === b, '移除后应剩 1 个');
  world.clear();
  assert(world.bodies.length === 0, 'clear 后应为空');
});

test('确定性：相同输入产生相同结果', () => {
  function run() {
    const world = new World();
    makeFloor(world);
    for (let i = 0; i < 5; i++) {
      world.addBody(
        new Body(Shapes.box(1, 0.5), {
          position: new Vec2(0.1 * i, 3 - 0.5 * i),
          angle: 0.01 * i,
          restitution: 0.2,
          friction: 0.5,
        })
      );
    }
    for (let i = 0; i < 360; i++) world.step(1 / 120);
    return world.bodies.map((b) => [b.position.x, b.position.y, b.angle]);
  }
  const a = run();
  const b = run();
  for (let i = 0; i < a.length; i++) {
    approx(a[i][0], b[i][0], 1e-12, `第 ${i} 个刚体 x`);
    approx(a[i][1], b[i][1], 1e-12, `第 ${i} 个刚体 y`);
    approx(a[i][2], b[i][2], 1e-12, `第 ${i} 个刚体角度`);
  }
});

// ---------------- 汇总 ----------------

console.log('\n' + '='.repeat(46));
console.log(`结果：${passed} 通过，${failed} 失败`);
console.log('='.repeat(46));

if (failed > 0) {
  console.log('\n失败详情：');
  for (const f of failures) {
    console.log(`\n- ${f.name}`);
    console.log(`  ${f.err.stack.split('\n').slice(0, 4).join('\n  ')}`);
  }
  process.exit(1);
}
