/*!
 * TinyFluid v1.0.0 — 2D 粒子流体（PBF / Position Based Fluids）
 * ------------------------------------------------------------
 * 用于 Tiny2D 沙盒的水：位置约束 + 密度约束，粒子之间会合并成
 * 连续水面、顺着地形流动、撞到刚体时溅开。
 *
 * 特点：
 *   - 不依赖网格，纯粒子 SPH/PBF
 *   - 空间哈希邻居搜索
 *   - 与 Tiny2D 的圆 / 凸多边形刚体碰撞
 *   - 支持给动态刚体传递冲量（水推木头）
 *
 * 浏览器：先加载 physics.js，再加载 fluid.js → 全局 TinyFluid
 * Node.js：const Fluid = require('./fluid.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const Tiny2D = require('./physics.js');
    module.exports = factory(Tiny2D);
  } else {
    root.TinyFluid = factory(root.Tiny2D);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Tiny2D) {
  'use strict';

  const { Vec2 } = Tiny2D;

  const DEFAULTS = {
    h: 0.18, // 平滑核半径（米）
    restDensity: 3.19, // 静止密度
    stiffness: 0.2, // 压力刚度倍率
    iterations: 2, // 密度约束迭代次数
    viscosity: 0.02, // XSPH 粘度
    particleRadius: 0.048, // 与刚体碰撞用的粒子半径
    maxParticles: 1000,
    maxSpeed: 12,
    gravity: 9.81,
    bounce: 0.05,
    friction: 0.12,
    coupling: 0.35, // 水对动态刚体的推力系数
  };

  class Fluid {
    constructor(options) {
      const opts = options || {};
      for (const key of Object.keys(DEFAULTS)) {
        this[key] = opts[key] != null ? opts[key] : DEFAULTS[key];
      }

      this.particles = [];
      this._h2 = this.h * this.h;
      this._invH2 = 1 / this._h2;
      this._invRho = 1 / this.restDensity;
      this._invRho2 = this._invRho * this._invRho;
      this._cellSize = this.h;
      this._grid = new Map();
      this._neighbors = [];
      this._scratch = [];
      this._particleCount = 0;
    }

    get count() {
      return this.particles.length;
    }

    clear() {
      this.particles.length = 0;
    }

    addParticle(x, y, vx, vy) {
      if (this.particles.length >= this.maxParticles) return false;
      this.particles.push({
        x,
        y,
        vx: vx || 0,
        vy: vy || 0,
        ox: x,
        oy: y,
        rho: this.restDensity,
        lambda: 0,
      });
      return true;
    }

    /** 在一点喷出 count 个水粒子 */
    emit(x, y, count, options) {
      const opts = options || {};
      const spread = opts.spread != null ? opts.spread : 0.1;
      const vx = opts.vx || 0;
      const vy = opts.vy || 0;
      const countInt = Math.max(0, Math.round(count));
      for (let i = 0; i < countInt; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random()) * spread;
        this.addParticle(
          x + Math.cos(angle) * radius,
          y + Math.sin(angle) * radius,
          vx + (Math.random() - 0.5) * 0.8,
          vy + (Math.random() - 0.5) * 0.8
        );
      }
    }

    /** 用网格填满一个矩形区域（用于场景预置水体） */
    fillRect(x0, y0, x1, y1, spacing, vx, vy) {
      const step = spacing || this.h * 0.55;
      for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) {
          this.addParticle(
            x + (Math.random() - 0.5) * step * 0.2,
            y + (Math.random() - 0.5) * step * 0.2,
            vx || 0,
            vy || 0
          );
        }
      }
    }

    /** 一步流体模拟 */
    step(dt, bodies) {
      const particles = this.particles;
      const n = particles.length;
      if (n === 0) return;

      this._buildNeighbors();

      // ---------- 1. 预测位置 ----------
      const gravity = this.gravity;
      for (let i = 0; i < n; i++) {
        const p = particles[i];
        p.vy += gravity * dt;
        // 轻微速度阻尼，避免飞溅发散
        p.vx *= 0.9995;
        p.vy *= 0.9995;
        p.ox = p.x;
        p.oy = p.y;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }

      // ---------- 2. 密度约束迭代 ----------
      for (let iter = 0; iter < this.iterations; iter++) {
        this._computeDensityAndLambda();
        this._applyPressure(dt);
      }

      // ---------- 3. 由位置差反推速度 ----------
      const invDt = 1 / dt;
      for (let i = 0; i < n; i++) {
        const p = particles[i];
        p.vx = (p.x - p.ox) * invDt;
        p.vy = (p.y - p.oy) * invDt;
      }

      // ---------- 4. 与刚体 / 场景碰撞 ----------
      if (bodies && bodies.length) {
        this._collideBodies(bodies);
      }

      // ---------- 5. 粘度平滑 + 限速 ----------
      if (this.viscosity > 0) {
        this._applyViscosity();
      }

      const maxSpeed = this.maxSpeed;
      const maxSpeedSq = maxSpeed * maxSpeed;
      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const speedSq = p.vx * p.vx + p.vy * p.vy;
        if (speedSq > maxSpeedSq) {
          const scale = maxSpeed / Math.sqrt(speedSq);
          p.vx *= scale;
          p.vy *= scale;
        }
        if (!Number.isFinite(p.x + p.y + p.vx + p.vy)) {
          // 极端情况下的保险：让粒子停住，等待被销毁
          p.x = p.ox;
          p.y = p.oy;
          p.vx = 0;
          p.vy = 0;
        }
      }
    }

    /** 移除飞出世界范围的粒子；返回移除数量 */
    cull(minX, minY, maxX, maxY) {
      const particles = this.particles;
      let removed = 0;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
          particles.splice(i, 1);
          removed++;
        }
      }
      return removed;
    }

    // ============================================================
    // 邻居搜索
    // ============================================================

    _cellKey(gx, gy) {
      // 支持负数坐标的唯一整数 key
      return (gx + 4096) * 8192 + (gy + 4096);
    }

    _buildNeighbors() {
      const particles = this.particles;
      const n = particles.length;
      const inv = 1 / this._cellSize;
      const grid = this._grid;
      grid.clear();

      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const gx = Math.floor(p.x * inv);
        const gy = Math.floor(p.y * inv);
        const key = this._cellKey(gx, gy);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(i);
      }

      const neighbors = this._neighbors;
      while (neighbors.length < n) neighbors.push([]);
      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const gx = Math.floor(p.x * inv);
        const gy = Math.floor(p.y * inv);
        const list = neighbors[i];
        list.length = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = grid.get(this._cellKey(gx + dx, gy + dy));
            if (!bucket) continue;
            for (let k = 0; k < bucket.length; k++) {
              const j = bucket[k];
              if (j !== i) list.push(j);
            }
          }
        }
      }
    }

    // ============================================================
    // PBF 密度约束
    // ============================================================

    _computeDensityAndLambda() {
      const particles = this.particles;
      const neighbors = this._neighbors;
      const n = particles.length;
      const h2 = this._h2;
      const invH2 = this._invH2;
      const invRho = this._invRho;
      const invRho2 = this._invRho2;

      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const list = neighbors[i];
        let rho = 1; // 包含自身
        let sumGx = 0;
        let sumGy = 0;
        let sumGradSq = 0;

        for (let k = 0; k < list.length; k++) {
          const q = particles[list[k]];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const r2 = dx * dx + dy * dy;
          if (r2 >= h2 || r2 < 1e-12) continue;

          const u = 1 - r2 * invH2;
          rho += u * u * u;

          // ∇W，W = (1 - r²/h²)³，∇W = -6/h² (1 - r²/h²)² · d
          const gw = -6 * invH2 * u * u;
          const gx = gw * dx;
          const gy = gw * dy;
          sumGx += gx;
          sumGy += gy;
          sumGradSq += gx * gx + gy * gy;
        }

        p.rho = rho;
        const gradSq =
          (sumGx * sumGx + sumGy * sumGy + sumGradSq) * invRho2;
        const constraint = rho * invRho - 1;
        // 只抵抗压缩，不主动吸引：稀疏/孤立的表面粒子没有邻居梯度，
        // 若同时允许负约束会产生数值爆炸。
        p.lambda = constraint > 0 ? -constraint / (gradSq + 1e-9) : 0;
      }
    }

    _applyPressure() {
      const particles = this.particles;
      const neighbors = this._neighbors;
      const n = particles.length;
      const h2 = this._h2;
      const invH2 = this._invH2;
      const invRho = this._invRho;
      const stiffness = this.stiffness;

      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const list = neighbors[i];
        let dxSum = 0;
        let dySum = 0;

        for (let k = 0; k < list.length; k++) {
          const q = particles[list[k]];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const r2 = dx * dx + dy * dy;
          if (r2 >= h2 || r2 < 1e-12) continue;

          const u = 1 - r2 * invH2;
          const gw = -6 * invH2 * u * u;
          const s = (p.lambda + q.lambda) * stiffness;
          dxSum += s * gw * dx;
          dySum += s * gw * dy;
        }

        p._dx = invRho * dxSum;
        p._dy = invRho * dySum;
      }

      for (let i = 0; i < n; i++) {
        const p = particles[i];
        p.x += p._dx;
        p.y += p._dy;
      }
    }

    _applyViscosity() {
      const particles = this.particles;
      const neighbors = this._neighbors;
      const n = particles.length;
      const h2 = this._h2;
      const invH2 = this._invH2;
      const viscosity = this.viscosity;

      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const list = neighbors[i];
        let sumW = 0;
        let sumVx = 0;
        let sumVy = 0;

        for (let k = 0; k < list.length; k++) {
          const q = particles[list[k]];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const r2 = dx * dx + dy * dy;
          if (r2 >= h2) continue;
          const u = 1 - r2 * invH2;
          const w = u * u * u;
          sumW += w;
          sumVx += q.vx * w;
          sumVy += q.vy * w;
        }

        if (sumW > 1e-6) {
          const blend = viscosity * Math.min(1, sumW * 0.1);
          p.vx += (sumVx / sumW - p.vx) * blend;
          p.vy += (sumVy / sumW - p.vy) * blend;
        }
      }
    }

    // ============================================================
    // 与刚体碰撞
    // ============================================================

    _collideBodies(bodies) {
      const particles = this.particles;
      const pr = this.particleRadius;
      const particles2 = particles;

      for (let i = 0; i < particles2.length; i++) {
        const p = particles2[i];
        for (let b = 0; b < bodies.length; b++) {
          const body = bodies[b];
          const aabb = body._aabb;
          if (
            !aabb ||
            p.x < aabb.minX - pr ||
            p.x > aabb.maxX + pr ||
            p.y < aabb.minY - pr ||
            p.y > aabb.maxY + pr
          ) {
            continue;
          }

          const hit = collideParticleWithBody(p, body, pr);
          if (!hit) continue;

          // 限制单步推出距离，避免初始重叠时把水粒子弹飞
          const pen = Math.min(hit.pen, 0.03);
          p.x += hit.nx * pen;
          p.y += hit.ny * pen;

          // 接触点处刚体的速度
          const rxp = p.x - body.position.x;
          const ryp = p.y - body.position.y;
          const bvx = body.velocity.x - body.angularVelocity * ryp;
          const bvy = body.velocity.y + body.angularVelocity * rxp;

          const rvx = p.vx - bvx;
          const rvy = p.vy - bvy;
          const vn = rvx * hit.nx + rvy * hit.ny;

          if (vn < 0) {
            const bounce = this.bounce;
            const j = -(1 + bounce) * vn;
            p.vx += hit.nx * j;
            p.vy += hit.ny * j;

            // 切向摩擦
            const tx = -hit.ny;
            const ty = hit.nx;
            const vt = rvx * tx + rvy * ty;
            const friction = this.friction;
            p.vx -= tx * vt * friction;
            p.vy -= ty * vt * friction;

            // 水把冲量传给动态刚体
            if (!body.isStatic && this.coupling > 0) {
              const impulse = -j * 0.01 * this.coupling;
              if (Math.abs(impulse) > 1e-9) {
                body.applyImpulse(
                  new Vec2(hit.nx * impulse, hit.ny * impulse),
                  new Vec2(p.x, p.y)
                );
              }
            }
          }
        }
      }
    }
  }

  /**
   * 粒子与刚体的碰撞检测。
   * 返回 { nx, ny, pen }（世界坐标下的推出法线和穿透深度），或 null。
   */
  function collideParticleWithBody(p, body, pr) {
    const shape = body.shape;
    const c = Math.cos(body.angle);
    const s = Math.sin(body.angle);
    const dx = p.x - body.position.x;
    const dy = p.y - body.position.y;
    const lx = c * dx + s * dy;
    const ly = -s * dx + c * dy;

    if (shape.type === 'circle') {
      const dist = Math.sqrt(lx * lx + ly * ly);
      const minDist = shape.radius + pr;
      if (dist >= minDist) return null;
      let nx;
      let ny;
      if (dist < 1e-9) {
        nx = 1;
        ny = 0;
      } else {
        nx = lx / dist;
        ny = ly / dist;
      }
      return {
        nx: c * nx - s * ny,
        ny: s * nx + c * ny,
        pen: minDist - dist,
      };
    }

    const verts = shape.vertices;
    const normals = shape.normals;
    let maxSep = -Infinity;
    let maxIndex = 0;

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const n = normals[i];
      const sep = (lx - v.x) * n.x + (ly - v.y) * n.y;
      if (sep > maxSep) {
        maxSep = sep;
        maxIndex = i;
      }
    }

    if (maxSep < 0) {
      // 粒子在多边形内部：沿最近的面推出去
      const n = normals[maxIndex];
      return {
        nx: c * n.x - s * n.y,
        ny: s * n.x + c * n.y,
        pen: -maxSep + pr,
      };
    }

    // 外部：找最近的边界点
    let bestDistSq = Infinity;
    let bestQx = 0;
    let bestQy = 0;
    for (let i = 0; i < verts.length; i++) {
      const v1 = verts[i];
      const v2 = verts[(i + 1) % verts.length];
      const ex = v2.x - v1.x;
      const ey = v2.y - v1.y;
      const lenSq = ex * ex + ey * ey;
      let t = ((lx - v1.x) * ex + (ly - v1.y) * ey) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = v1.x + ex * t;
      const qy = v1.y + ey * t;
      const ddx = lx - qx;
      const ddy = ly - qy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestQx = qx;
        bestQy = qy;
      }
    }

    const dist = Math.sqrt(bestDistSq);
    if (dist >= pr) return null;

    let nx;
    let ny;
    if (dist < 1e-9) {
      nx = normals[maxIndex].x;
      ny = normals[maxIndex].y;
    } else {
      nx = (lx - bestQx) / dist;
      ny = (ly - bestQy) / dist;
    }

    return {
      nx: c * nx - s * ny,
      ny: s * nx + c * ny,
      pen: pr - dist,
    };
  }

  Fluid.DEFAULTS = DEFAULTS;
  Fluid.collideParticleWithBody = collideParticleWithBody;
  return Fluid;
});
