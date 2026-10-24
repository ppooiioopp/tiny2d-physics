/*!
 * Tiny2D v1.0.0 — 一个轻量级 2D 刚体物理引擎
 * ------------------------------------------------------------
 * 纯 JavaScript，无任何依赖，同时支持：
 *   - 浏览器：<script src="physics.js"></script> → 全局 Tiny2D
 *   - Node.js：const Tiny2D = require('./physics.js')
 *
 * 支持：圆 / 凸多边形（盒、三角、任意凸多边形）、重力、恢复系数、
 *       摩擦、顺序冲量求解、接触流形裁剪、热启动、AABB 宽相。
 *
 * 约定：世界坐标 y 轴向下为正（与 Canvas 一致），所以重力默认 (0, 9.81)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Tiny2D = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const EPS = 1e-9;

  // ============================================================
  // 向量
  // ============================================================

  class Vec2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }

    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    }

    clone() {
      return new Vec2(this.x, this.y);
    }

    copy(v) {
      this.x = v.x;
      this.y = v.y;
      return this;
    }

    add(v) {
      this.x += v.x;
      this.y += v.y;
      return this;
    }

    sub(v) {
      this.x -= v.x;
      this.y -= v.y;
      return this;
    }

    scale(s) {
      this.x *= s;
      this.y *= s;
      return this;
    }

    addScaled(v, s) {
      this.x += v.x * s;
      this.y += v.y * s;
      return this;
    }

    negate() {
      this.x = -this.x;
      this.y = -this.y;
      return this;
    }

    dot(v) {
      return this.x * v.x + this.y * v.y;
    }

    /** 二维叉积标量：a × b = ax*by - ay*bx */
    cross(v) {
      return this.x * v.y - this.y * v.x;
    }

    length() {
      return Math.hypot(this.x, this.y);
    }

    lengthSquared() {
      return this.x * this.x + this.y * this.y;
    }

    normalize() {
      const len = Math.hypot(this.x, this.y);
      if (len > EPS) {
        this.x /= len;
        this.y /= len;
      }
      return this;
    }

    rotate(angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const x = c * this.x - s * this.y;
      const y = s * this.x + c * this.y;
      this.x = x;
      this.y = y;
      return this;
    }

    /** 点到点的距离平方 */
    distanceSquared(v) {
      const dx = this.x - v.x;
      const dy = this.y - v.y;
      return dx * dx + dy * dy;
    }

    toString() {
      return `Vec2(${this.x.toFixed(3)}, ${this.y.toFixed(3)})`;
    }
  }

  function vec(x = 0, y = 0) {
    return new Vec2(x, y);
  }

  // 内部用的纯函数版本
  function rotateVec(v, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  }

  function invRotateVec(v, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vec2(c * v.x + s * v.y, -s * v.x + c * v.y);
  }

  // ============================================================
  // 形状
  // ============================================================

  class Circle {
    constructor(radius) {
      if (!(radius > 0)) throw new Error('圆的半径必须大于 0');
      this.type = 'circle';
      this.radius = radius;
    }

    computeMass(density) {
      const mass = Math.PI * this.radius * this.radius * density;
      // 圆盘绕质心的转动惯量：1/2 m r²
      return { mass, inertia: 0.5 * mass * this.radius * this.radius };
    }

    computeAABB(position) {
      const r = this.radius;
      return {
        minX: position.x - r,
        maxX: position.x + r,
        minY: position.y - r,
        maxY: position.y + r,
      };
    }

    containsLocal(point) {
      return point.lengthSquared() <= this.radius * this.radius;
    }
  }

  class Polygon {
    /**
     * @param {Vec2[]|number[][]} vertices 局部坐标下的凸多边形顶点（任意顺序）
     */
    constructor(vertices) {
      if (!Array.isArray(vertices) || vertices.length < 3) {
        throw new Error('多边形至少需要 3 个顶点');
      }

      const pts = vertices.map((p) =>
        Array.isArray(p) ? new Vec2(p[0], p[1]) : new Vec2(p.x, p.y)
      );

      // 计算面积与质心（鞋带公式）
      let signedArea = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        const cross = p1.cross(p2);
        signedArea += cross;
        cx += (p1.x + p2.x) * cross;
        cy += (p1.y + p2.y) * cross;
      }
      signedArea *= 0.5;

      if (Math.abs(signedArea) < EPS) {
        throw new Error('多边形面积不能为 0');
      }

      // 统一为逆时针（数学坐标系下面积为正）便于法线计算
      if (signedArea < 0) {
        pts.reverse();
        signedArea = -signedArea;
      }

      cx /= 6 * signedArea;
      cy /= 6 * signedArea;

      // 把质心移到局部原点，旋转时更方便
      const adjusted = pts.map((p) => new Vec2(p.x - cx, p.y - cy));

      const normals = [];
      for (let i = 0; i < adjusted.length; i++) {
        const p1 = adjusted[i];
        const p2 = adjusted[(i + 1) % adjusted.length];
        // 逆时针顶点顺序下，边 (dx, dy) 的外法线为 (dy, -dx)
        normals.push(new Vec2(p2.y - p1.y, -(p2.x - p1.x)).normalize());
      }

      this.type = 'polygon';
      this.vertices = adjusted;
      this.normals = normals;
      this.area = signedArea;
      this.centroidOffset = new Vec2(cx, cy);
    }

    computeMass(density) {
      // 多边形绕原点（此处即质心）的转动惯量
      let inertia = 0;
      for (let i = 0; i < this.vertices.length; i++) {
        const p1 = this.vertices[i];
        const p2 = this.vertices[(i + 1) % this.vertices.length];
        const cross = p1.cross(p2);
        inertia +=
          cross *
          (p1.x * p1.x + p1.x * p2.x + p2.x * p2.x +
           p1.y * p1.y + p1.y * p2.y + p2.y * p2.y);
      }
      const mass = density * this.area;
      return { mass, inertia: (density * inertia) / 12 };
    }

    computeAABB(position, angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const v of this.vertices) {
        const x = position.x + c * v.x - s * v.y;
        const y = position.y + s * v.x + c * v.y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { minX, maxX, minY, maxY };
    }

    containsLocal(point) {
      for (let i = 0; i < this.vertices.length; i++) {
        const v = this.vertices[i];
        const n = this.normals[i];
        if ((point.x - v.x) * n.x + (point.y - v.y) * n.y > 1e-7) {
          return false;
        }
      }
      return true;
    }
  }

  /** 形状工厂 */
  const Shapes = {
    circle(radius) {
      return new Circle(radius);
    },

    /** 以原点为中心的矩形，宽 w 高 h */
    box(width, height) {
      const hw = width / 2;
      const hh = height / 2;
      return new Polygon([
        new Vec2(-hw, -hh),
        new Vec2(hw, -hh),
        new Vec2(hw, hh),
        new Vec2(-hw, hh),
      ]);
    },

    /** 任意凸多边形（会校验并自动重排为逆时针） */
    polygon(vertices) {
      return new Polygon(vertices);
    },

    /** 等腰三角形，宽 w 高 h，顶点朝上（屏幕坐标） */
    triangle(width, height) {
      const hw = width / 2;
      const hh = height / 2;
      return new Polygon([
        new Vec2(-hw, hh),
        new Vec2(0, -hh),
        new Vec2(hw, hh),
      ]);
    },
  };

  // ============================================================
  // 刚体
  // ============================================================

  let _nextBodyId = 1;

  class Body {
    /**
     * @param {Circle|Polygon} shape
     * @param {object} [options]
     *   position, angle, velocity, angularVelocity,
     *   isStatic, density, mass, inertia,
     *   restitution, friction, linearDamping, angularDamping, color, userData
     */
    constructor(shape, options = {}) {
      if (!shape || (shape.type !== 'circle' && shape.type !== 'polygon')) {
        throw new Error('Body 需要一个合法的形状（Circle 或 Polygon）');
      }

      this.id = _nextBodyId++;
      this.shape = shape;
      this.position = options.position ? options.position.clone() : new Vec2();
      this.angle = options.angle || 0;
      this.velocity = options.velocity ? options.velocity.clone() : new Vec2();
      this.angularVelocity = options.angularVelocity || 0;

      this.isStatic = Boolean(options.isStatic || options.static);
      this.restitution = options.restitution != null ? options.restitution : 0.2;
      this.friction = options.friction != null ? options.friction : 0.4;
      this.linearDamping = options.linearDamping || 0;
      this.angularDamping = options.angularDamping || 0;

      this.color = options.color || null;
      this.userData = options.userData || null;

      if (this.isStatic) {
        this.mass = 0;
        this.invMass = 0;
        this.inertia = 0;
        this.invInertia = 0;
      } else {
        const density = options.density != null ? options.density : 1;
        const props = shape.computeMass(density);
        const mass = options.mass != null ? options.mass : props.mass;
        const inertia =
          options.inertia != null
            ? options.inertia
            : props.inertia * (mass / props.mass);
        if (!(mass > 0) || !(inertia > 0)) {
          throw new Error('刚体质量与转动惯量必须大于 0');
        }
        this.mass = mass;
        this.invMass = 1 / mass;
        this.inertia = inertia;
        this.invInertia = 1 / inertia;
      }

      this._aabb = null;
    }

    get isDynamic() {
      return !this.isStatic;
    }

    /** 局部坐标 → 世界坐标 */
    localToWorld(point) {
      const c = Math.cos(this.angle);
      const s = Math.sin(this.angle);
      return new Vec2(
        this.position.x + c * point.x - s * point.y,
        this.position.y + s * point.x + c * point.y
      );
    }

    /** 世界坐标 → 局部坐标 */
    worldToLocal(point) {
      const c = Math.cos(this.angle);
      const s = Math.sin(this.angle);
      const dx = point.x - this.position.x;
      const dy = point.y - this.position.y;
      return new Vec2(c * dx + s * dy, -s * dx + c * dy);
    }

    /** 世界坐标点的速度（线速度 + 角速度贡献） */
    velocityAtPoint(point, out = new Vec2()) {
      const rx = point.x - this.position.x;
      const ry = point.y - this.position.y;
      out.x = this.velocity.x - this.angularVelocity * ry;
      out.y = this.velocity.y + this.angularVelocity * rx;
      return out;
    }

    /** 在世界坐标点施加冲量（静态体无效） */
    applyImpulse(impulse, point = this.position) {
      if (this.isStatic) return;
      const rx = point.x - this.position.x;
      const ry = point.y - this.position.y;
      this.velocity.x += impulse.x * this.invMass;
      this.velocity.y += impulse.y * this.invMass;
      this.angularVelocity += this.invInertia * (rx * impulse.y - ry * impulse.x);
    }

    /** 直接设置线速度 */
    setVelocity(x, y) {
      this.velocity.set(x, y);
      return this;
    }

    computeAABB() {
      this._aabb = this.shape.computeAABB(this.position, this.angle);
      return this._aabb;
    }

    containsPoint(point) {
      return this.shape.containsLocal(this.worldToLocal(point));
    }
  }

  // ============================================================
  // 碰撞检测
  // ============================================================

  /** 计算相对速度：点相对于 A、B 两刚体的速度差（B - A） */
  function relativeVelocityAt(A, B, point, rA, rB, out) {
    out.x =
      B.velocity.x - B.angularVelocity * rB.y -
      (A.velocity.x - A.angularVelocity * rA.y);
    out.y =
      B.velocity.y + B.angularVelocity * rB.x -
      (A.velocity.y + A.angularVelocity * rA.x);
    return out;
  }

  function collideCircleCircle(A, B) {
    const ra = A.shape.radius;
    const rb = B.shape.radius;
    const dx = B.position.x - A.position.x;
    const dy = B.position.y - A.position.y;
    const distSq = dx * dx + dy * dy;
    const radiusSum = ra + rb;

    if (distSq > radiusSum * radiusSum) return null;

    const dist = Math.sqrt(distSq);
    let nx;
    let ny;
    let separation;
    let px;
    let py;

    if (dist < 1e-7) {
      nx = 1;
      ny = 0;
      separation = -radiusSum;
      px = A.position.x;
      py = A.position.y;
    } else {
      nx = dx / dist;
      ny = dy / dist;
      separation = dist - radiusSum;
      const offset = ra + separation * 0.5;
      px = A.position.x + nx * offset;
      py = A.position.y + ny * offset;
    }

    return {
      bodyA: A,
      bodyB: B,
      normal: new Vec2(nx, ny),
      points: [{ position: new Vec2(px, py), separation }],
    };
  }

  /**
   * 圆与多边形。返回法线方向为「圆 → 多边形」。
   * 若圆在内部，分离量按穿透深度计算。
   */
  function collideCirclePolygon(circleBody, polyBody) {
    const circle = circleBody.shape;
    const poly = polyBody.shape;
    const localCenter = polyBody.worldToLocal(circleBody.position);
    const verts = poly.vertices;

    let bestX = 0;
    let bestY = 0;
    let bestDistSq = Infinity;
    let bestNormalX = 0;
    let bestNormalY = -1;

    for (let i = 0; i < verts.length; i++) {
      const v1 = verts[i];
      const v2 = verts[(i + 1) % verts.length];
      const ex = v2.x - v1.x;
      const ey = v2.y - v1.y;
      const lenSq = ex * ex + ey * ey;
      let t = ((localCenter.x - v1.x) * ex + (localCenter.y - v1.y) * ey) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;

      const qx = v1.x + ex * t;
      const qy = v1.y + ey * t;
      const dx = localCenter.x - qx;
      const dy = localCenter.y - qy;
      const distSq = dx * dx + dy * dy;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestX = qx;
        bestY = qy;
        bestNormalX = poly.normals[i].x;
        bestNormalY = poly.normals[i].y;
      }
    }

    const dist = Math.sqrt(bestDistSq);
    const inside = poly.containsLocal(localCenter);

    if (!inside && dist > circle.radius) return null;

    let nx;
    let ny;
    let separation;

    if (dist < 1e-7) {
      // 圆心几乎正好落在边界上：沿最近的面的外法线反方向推开
      nx = -bestNormalX;
      ny = -bestNormalY;
      separation = inside ? -(circle.radius + dist) : -circle.radius;
    } else if (inside) {
      // 圆心在多边形内部：把圆推向最近的边界（圆心指向边界的反方向）
      nx = (localCenter.x - bestX) / dist;
      ny = (localCenter.y - bestY) / dist;
      separation = -(circle.radius + dist);
    } else {
      // 圆心在多边形外部：法线指向最近边界点，圆会被推向反方向
      nx = (bestX - localCenter.x) / dist;
      ny = (bestY - localCenter.y) / dist;
      separation = dist - circle.radius;
    }

    // 法线转到世界坐标（圆 → 多边形）
    const c = Math.cos(polyBody.angle);
    const s = Math.sin(polyBody.angle);
    const normal = new Vec2(c * nx - s * ny, s * nx + c * ny);
    const position = polyBody.localToWorld(new Vec2(bestX, bestY));

    return {
      bodyA: circleBody,
      bodyB: polyBody,
      normal, // 圆 → 多边形
      points: [{ position, separation }],
    };
  }

  /** SAT：找出 A 的哪条边法线给出最大的分离量 */
  function findMaxSeparation(polyA, bodyA, polyB, bodyB) {
    const c = Math.cos(bodyA.angle);
    const s = Math.sin(bodyA.angle);
    const dx = bodyB.position.x - bodyA.position.x;
    const dy = bodyB.position.y - bodyA.position.y;

    // B 的位移转换到 A 的局部坐标系
    const localDx = c * dx + s * dy;
    const localDy = -s * dx + c * dy;

    const relAngle = bodyB.angle - bodyA.angle;
    const c2 = Math.cos(relAngle);
    const s2 = Math.sin(relAngle);

    let bestSep = -Infinity;
    let bestIndex = 0;

    for (let i = 0; i < polyA.vertices.length; i++) {
      const n = polyA.normals[i];
      const v = polyA.vertices[i];
      let minSep = Infinity;

      for (let j = 0; j < polyB.vertices.length; j++) {
        const p = polyB.vertices[j];
        const rx = c2 * p.x - s2 * p.y + localDx;
        const ry = s2 * p.x + c2 * p.y + localDy;
        const sep = (rx - v.x) * n.x + (ry - v.y) * n.y;
        if (sep < minSep) minSep = sep;
      }

      if (minSep > bestSep) {
        bestSep = minSep;
        bestIndex = i;
      }
    }

    return { separation: bestSep, index: bestIndex };
  }

  /**
   * 用一条直线裁剪线段，保留满足 normal·p - offset <= 0 的部分。
   * 结果最多 2 个点。
   */
  function clipSegmentToLine(out, input, normal, offset) {
    let count = 0;
    const d0 = normal.dot(input[0].v) - offset;
    const d1 = normal.dot(input[1].v) - offset;

    if (d0 <= 0) out[count++] = input[0];
    if (d1 <= 0) out[count++] = input[1];

    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      out[count++] = {
        v: new Vec2(
          input[0].v.x + t * (input[1].v.x - input[0].v.x),
          input[0].v.y + t * (input[1].v.y - input[0].v.y)
        ),
      };
    }

    return count;
  }

  function collidePolygonPolygon(A, B) {
    const polyA = A.shape;
    const polyB = B.shape;

    const sepA = findMaxSeparation(polyA, A, polyB, B);
    if (sepA.separation > 0) return null;

    const sepB = findMaxSeparation(polyB, B, polyA, A);
    if (sepB.separation > 0) return null;

    let refBody;
    let incBody;
    let refPoly;
    let incPoly;
    let refIndex;
    let flip;

    if (sepA.separation >= sepB.separation) {
      refBody = A;
      incBody = B;
      refPoly = polyA;
      incPoly = polyB;
      refIndex = sepA.index;
      flip = false;
    } else {
      refBody = B;
      incBody = A;
      refPoly = polyB;
      incPoly = polyA;
      refIndex = sepB.index;
      flip = true;
    }

    const refVerts = refPoly.vertices;
    const nWorld = rotateVec(refPoly.normals[refIndex], refBody.angle);
    const v1 = refBody.localToWorld(refVerts[refIndex]);
    const v2 = refBody.localToWorld(refVerts[(refIndex + 1) % refVerts.length]);
    const tangent = new Vec2(v2.x - v1.x, v2.y - v1.y).normalize();
    const tangentOffset1 = tangent.dot(v1);
    const tangentOffset2 = tangent.dot(v2);
    const refOffset = nWorld.dot(v1);

    // 入射边：法线与参考面法线最反向的那条边
    let incidentIndex = 0;
    let minDot = Infinity;
    for (let i = 0; i < incPoly.vertices.length; i++) {
      const worldNormal = rotateVec(incPoly.normals[i], incBody.angle);
      const d = worldNormal.dot(nWorld);
      if (d < minDot) {
        minDot = d;
        incidentIndex = i;
      }
    }

    const incVerts = incPoly.vertices;
    const incV1 = incBody.localToWorld(incVerts[incidentIndex]);
    const incV2 = incBody.localToWorld(
      incVerts[(incidentIndex + 1) % incVerts.length]
    );

    const out = new Array(2);
    let count = clipSegmentToLine(
      out,
      [{ v: incV1 }, { v: incV2 }],
      new Vec2(-tangent.x, -tangent.y),
      -tangentOffset1
    );
    if (count < 2) return null;

    const clipped = [out[0], out[1]];
    count = clipSegmentToLine(out, clipped, tangent, tangentOffset2);
    if (count < 2) return null;

    const points = [];
    for (let i = 0; i < 2; i++) {
      const p = out[i];
      const separation = nWorld.dot(p.v) - refOffset;
      if (separation <= 0) {
        points.push({ position: p.v.clone(), separation });
      }
    }

    if (points.length === 0) return null;

    // 法线方向统一为 A → B
    const normal = flip ? new Vec2(-nWorld.x, -nWorld.y) : nWorld;

    return { bodyA: A, bodyB: B, normal, points };
  }

  /** 主碰撞入口：返回 A → B 的接触流形，或 null */  function collide(A, B) {
    const ta = A.shape.type;
    const tb = B.shape.type;

    if (ta === 'circle' && tb === 'circle') {
      return collideCircleCircle(A, B);
    }

    if (ta === 'circle' && tb === 'polygon') {
      return collideCirclePolygon(A, B);
    }

    if (ta === 'polygon' && tb === 'circle') {
      const contact = collideCirclePolygon(B, A);
      if (!contact) return null;
      // 之前法线是「圆 → 多边形」，现在需要「多边形 → 圆」
      return {
        bodyA: A,
        bodyB: B,
        normal: new Vec2(-contact.normal.x, -contact.normal.y),
        points: contact.points,
      };
    }

    return collidePolygonPolygon(A, B);
  }

  // ============================================================
  // 世界
  // ============================================================

  let _nextWorldId = 1;

  class World {
    /**
     * @param {object} [options]
     *   gravity: Vec2（默认 (0, 9.81)）
     *   iterations: 速度迭代次数（默认 10）
     *   positionCorrection: Baumgarte 系数（默认 0.2）
     *   slop: 允许的穿透容差（默认 0.005 m）
     *   restitutionThreshold: 低于该相对速度不产生弹性（默认 1 m/s）
     */
    constructor(options = {}) {
      this.id = _nextWorldId++;
      this.gravity = options.gravity ? options.gravity.clone() : new Vec2(0, 9.81);
      this.iterations = options.iterations != null ? options.iterations : 10;
      this.positionCorrection =
        options.positionCorrection != null ? options.positionCorrection : 0.2;
      this.slop = options.slop != null ? options.slop : 0.005;
      this.restitutionThreshold =
        options.restitutionThreshold != null ? options.restitutionThreshold : 1.0;

      this.bodies = [];
      this.contacts = [];
      this.time = 0;
      this.stepCount = 0;
      this._contactCache = new Map();

      this._rv = new Vec2();
    }

    addBody(body) {
      if (!(body instanceof Body)) throw new Error('addBody 需要 Body 实例');
      this.bodies.push(body);
      return body;
    }

    removeBody(body) {
      const idx = this.bodies.indexOf(body);
      if (idx !== -1) {
        this.bodies.splice(idx, 1);
        // 同步清理涉及该刚体的接触，避免渲染/查询到过期数据
        this.contacts = this.contacts.filter(
          (c) => c.bodyA !== body && c.bodyB !== body
        );
      }
      return idx !== -1;
    }

    clear() {
      this.bodies.length = 0;
      this.contacts.length = 0;
      this._contactCache.clear();
      this.time = 0;
      this.stepCount = 0;
    }

    /** 返回包含该世界坐标点的最上层刚体（从后往前找） */
    queryPoint(point, includeStatic = false) {
      for (let i = this.bodies.length - 1; i >= 0; i--) {
        const body = this.bodies[i];
        if (body.isStatic && !includeStatic) continue;
        if (body.containsPoint(point)) return body;
      }
      return null;
    }

    /**
     * 推进一个物理步。dt 单位为秒。
     * 建议使用固定步长（如 1/120）以保证稳定与可复现。
     */
    step(dt) {
      if (!(dt > 0)) return;

      const bodies = this.bodies;
      const gravity = this.gravity;

      // ---------- 1. 速度积分（半隐式欧拉：先加速度后位置） ----------
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        if (body.isStatic) continue;

        body.velocity.x += gravity.x * dt;
        body.velocity.y += gravity.y * dt;

        if (body.linearDamping > 0) {
          const factor = Math.max(0, 1 - body.linearDamping * dt);
          body.velocity.x *= factor;
          body.velocity.y *= factor;
        }
        if (body.angularDamping > 0) {
          body.angularVelocity *= Math.max(0, 1 - body.angularDamping * dt);
        }
      }

      // ---------- 2. 宽相 + 窄相 ----------
      for (let i = 0; i < bodies.length; i++) {
        bodies[i].computeAABB();
      }

      const contacts = [];
      this.contacts = contacts;

      for (let i = 0; i < bodies.length; i++) {
        const A = bodies[i];
        const aabbA = A._aabb;
        for (let j = i + 1; j < bodies.length; j++) {
          const B = bodies[j];
          if (A.isStatic && B.isStatic) continue;

          const aabbB = B._aabb;
          if (
            aabbA.minX > aabbB.maxX ||
            aabbA.maxX < aabbB.minX ||
            aabbA.minY > aabbB.maxY ||
            aabbA.maxY < aabbB.minY
          ) {
            continue;
          }

          const contact = collide(A, B);
          if (contact && contact.points.length > 0) {
            contacts.push(contact);
          }
        }
      }

      // ---------- 3. 预处理：热启动 + 求解参数 ----------
      const newCache = new Map();
      const invDt = 1 / dt;
      const rv = this._rv;

      for (let ci = 0; ci < contacts.length; ci++) {
        const contact = contacts[ci];
        const A = contact.bodyA;
        const B = contact.bodyB;
        const n = contact.normal;
        const t = new Vec2(-n.y, n.x);
        contact.tangent = t;
        contact.friction = Math.sqrt(A.friction * B.friction);
        contact.restitution = Math.max(A.restitution, B.restitution);

        const key = A.id + ':' + B.id;
        let cached = null;
        if (this._contactCache.has(key)) {
          cached = this._contactCache.get(key);
          if (cached.normal.dot(n) < 0.95) cached = null;
        }

        for (let pi = 0; pi < contact.points.length; pi++) {
          const p = contact.points[pi];

          p.rA = new Vec2(p.position.x - A.position.x, p.position.y - A.position.y);
          p.rB = new Vec2(p.position.x - B.position.x, p.position.y - B.position.y);

          // 法向有效质量
          const rnA = p.rA.cross(n);
          const rnB = p.rB.cross(n);
          const kn =
            A.invMass + B.invMass +
            A.invInertia * rnA * rnA +
            B.invInertia * rnB * rnB;
          p.normalMass = kn > 0 ? 1 / kn : 0;

          // 切向有效质量
          const rtA = p.rA.cross(t);
          const rtB = p.rB.cross(t);
          const kt =
            A.invMass + B.invMass +
            A.invInertia * rtA * rtA +
            B.invInertia * rtB * rtB;
          p.tangentMass = kt > 0 ? 1 / kt : 0;

          // RESTITUTION 与 Baumgarte 位置修正
          relativeVelocityAt(A, B, p.position, p.rA, p.rB, rv);
          const vn = rv.dot(n);
          let restitutionBias = 0;
          if (vn < -this.restitutionThreshold) {
            restitutionBias = -contact.restitution * vn;
          }
          const positionBias = Math.min(
            10,
            -this.positionCorrection * invDt * Math.min(0, p.separation + this.slop)
          );
          // 恢复系数生效时不要再叠加位置修正，否则会凭空增加能量
          p.bias = restitutionBias > 0 ? restitutionBias : positionBias;

          // 热启动：复用上一帧的累计冲量
          let matched = null;
          if (cached) {
            for (let k = 0; k < cached.points.length; k++) {
              const old = cached.points[k];
              if (!old.used && old.position.distanceSquared(p.position) < 0.01) {
                matched = old;
                old.used = true;
                break;
              }
            }
          }
          p.normalImpulse = matched ? matched.normalImpulse : 0;
          p.tangentImpulse = matched ? matched.tangentImpulse : 0;
        }

        // 先算完所有点的恢复冲量，再施加热启动冲量
        for (let pi = 0; pi < contact.points.length; pi++) {
          const p = contact.points[pi];
          if (p.normalImpulse !== 0 || p.tangentImpulse !== 0) {
            const px = n.x * p.normalImpulse + t.x * p.tangentImpulse;
            const py = n.y * p.normalImpulse + t.y * p.tangentImpulse;
            applyImpulsePair(A, B, p.rA, p.rB, px, py);
          }
        }

        const cachePoints = [];
        for (let pi = 0; pi < contact.points.length; pi++) {
          const p = contact.points[pi];
          cachePoints.push({
            position: p.position.clone(),
            normalImpulse: 0,
            tangentImpulse: 0,
            used: false,
          });
        }
        newCache.set(key, { normal: n.clone(), points: cachePoints });
      }

      // ---------- 4. 顺序冲量求解 ----------
      for (let iter = 0; iter < this.iterations; iter++) {
        for (let ci = 0; ci < contacts.length; ci++) {
          const contact = contacts[ci];
          const A = contact.bodyA;
          const B = contact.bodyB;
          const n = contact.normal;
          const t = contact.tangent;
          const maxFriction = contact.friction;

          for (let pi = 0; pi < contact.points.length; pi++) {
            const p = contact.points[pi];
            const rA = p.rA;
            const rB = p.rB;

            // ---- 法向 ----
            relativeVelocityAt(A, B, p.position, rA, rB, rv);
            const vn = rv.x * n.x + rv.y * n.y;
            let dPn = p.normalMass * (-vn + p.bias);
            const oldPn = p.normalImpulse;
            let newPn = oldPn + dPn;
            if (newPn < 0) newPn = 0;
            dPn = newPn - oldPn;
            p.normalImpulse = newPn;
            applyImpulsePair(A, B, rA, rB, n.x * dPn, n.y * dPn);

            // ---- 切向（库仑摩擦）----
            relativeVelocityAt(A, B, p.position, rA, rB, rv);
            const vt = rv.x * t.x + rv.y * t.y;
            let dPt = p.tangentMass * -vt;
            const maxPt = maxFriction * p.normalImpulse;
            const oldPt = p.tangentImpulse;
            let newPt = oldPt + dPt;
            if (newPt < -maxPt) newPt = -maxPt;
            else if (newPt > maxPt) newPt = maxPt;
            dPt = newPt - oldPt;
            p.tangentImpulse = newPt;
            applyImpulsePair(A, B, rA, rB, t.x * dPt, t.y * dPt);
          }
        }
      }

      // ---------- 5. 位置积分 ----------
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        if (body.isStatic) continue;
        body.position.x += body.velocity.x * dt;
        body.position.y += body.velocity.y * dt;
        body.angle += body.angularVelocity * dt;
      }

      // ---------- 6. 保存接触缓存（供下一帧热启动） ----------
      for (let ci = 0; ci < contacts.length; ci++) {
        const contact = contacts[ci];
        const A = contact.bodyA;
        const B = contact.bodyB;
        const key = A.id + ':' + B.id;
        const entry = newCache.get(key);
        if (!entry) continue;
        for (let pi = 0; pi < contact.points.length; pi++) {
          const p = contact.points[pi];
          const cp = entry.points[pi];
          cp.normalImpulse = p.normalImpulse;
          cp.tangentImpulse = p.tangentImpulse;
        }
      }
      this._contactCache = newCache;

      this.time += dt;
      this.stepCount++;
    }

    /** 当前动态刚体数量 */
    get dynamicBodyCount() {
      let count = 0;
      for (const body of this.bodies) {
        if (!body.isStatic) count++;
      }
      return count;
    }
  }

  /** 对 A 施加 -P、对 B 施加 +P（在世界点，r 为相对质心的位置） */
  function applyImpulsePair(A, B, rA, rB, px, py) {
    if (A.invMass > 0) {
      A.velocity.x -= px * A.invMass;
      A.velocity.y -= py * A.invMass;
      A.angularVelocity -= A.invInertia * (rA.x * py - rA.y * px);
    }
    if (B.invMass > 0) {
      B.velocity.x += px * B.invMass;
      B.velocity.y += py * B.invMass;
      B.angularVelocity += B.invInertia * (rB.x * py - rB.y * px);
    }
  }

  return {
    version: VERSION,
    Vec2,
    vec,
    Circle,
    Polygon,
    Shapes,
    Body,
    World,
    collide,
  };
});
