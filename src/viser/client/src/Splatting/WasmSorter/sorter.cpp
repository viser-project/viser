#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <wasm_simd128.h>

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

/** SIMD dot product between two 4D vectors. */
__attribute__((always_inline)) inline float
dot_f32x4(const v128_t &a, const v128_t &b) {
    v128_t product = wasm_f32x4_mul(a, b);
    v128_t temp = wasm_f32x4_add(
        product, wasm_i32x4_shuffle(product, product, 1, 0, 3, 2)
    );
    v128_t tmp =
        wasm_f32x4_add(temp, wasm_i32x4_shuffle(temp, temp, 2, 3, 0, 1));
    return wasm_f32x4_extract_lane(tmp, 0);
}

// Function to find the minimum value across a v128_t i32x4 vector.
__attribute__((always_inline)) inline int32_t min_i32x4(v128_t vector) {
    int32_t elem0 = wasm_i32x4_extract_lane(vector, 0);
    int32_t elem1 = wasm_i32x4_extract_lane(vector, 1);
    int32_t elem2 = wasm_i32x4_extract_lane(vector, 2);
    int32_t elem3 = wasm_i32x4_extract_lane(vector, 3);
    return std::min({elem0, elem1, elem2, elem3});
}

// Function to find the maximum value across a v128_t i32x4 vector and return it
// as a float.
__attribute__((always_inline)) inline int32_t max_i32x4(v128_t vector) {
    int32_t elem0 = wasm_i32x4_extract_lane(vector, 0);
    int32_t elem1 = wasm_i32x4_extract_lane(vector, 1);
    int32_t elem2 = wasm_i32x4_extract_lane(vector, 2);
    int32_t elem3 = wasm_i32x4_extract_lane(vector, 3);
    return std::max({elem0, elem1, elem2, elem3});
}

class Sorter {
    std::vector<v128_t> centers_homog; // Centers as homogeneous coordinates.
    std::vector<uint32_t> group_indices;
    std::vector<uint32_t> sorted_indices;

  public:
    Sorter(
        const emscripten::val &buffer, const emscripten::val &group_indices_val
    ) {
        setBuffer(buffer, group_indices_val);
    };

    // Update the buffer and group indices. This allows dynamic updates without
    // recreating the sorter.
    void setBuffer(
        const emscripten::val &buffer, const emscripten::val &group_indices_val
    ) {
        const std::vector<uint32_t> bufferVec =
            emscripten::convertJSArrayToNumberVector<uint32_t>(buffer);
        const float *floatBuffer =
            reinterpret_cast<const float *>(bufferVec.data());
        const int32_t num_gaussians = bufferVec.size() / 8;
        sorted_indices.resize(num_gaussians);
        centers_homog.resize(num_gaussians);
        for (int32_t i = 0; i < num_gaussians; i++) {
            centers_homog[i] = wasm_f32x4_make(
                floatBuffer[i * 8 + 0],
                floatBuffer[i * 8 + 1],
                floatBuffer[i * 8 + 2],
                1.0
            );
        }
        group_indices =
            emscripten::convertJSArrayToNumberVector<uint32_t>(group_indices_val
            );
    }

    // Run sorting using the newest view projection matrix. Mutates internal
    // buffers.
    emscripten::val sort(const emscripten::val &Tz_cam_groups_val) {
        const auto Tz_cam_groups_buffer =
            emscripten::convertJSArrayToNumberVector<float>(Tz_cam_groups_val);
        const int32_t num_gaussians = centers_homog.size();

        // We do a 16-bit counting sort. This is mostly translated from Kevin
        // Kwok's Javascript implementation:
        //     https://github.com/antimatter15/splat/blob/main/main.js
        //
        // Note: we want to sort from minimum Z (high depth) to maximum Z (low
        // depth).
        const int32_t padded_length = std::ceil(num_gaussians / 4.0);
        std::vector<v128_t> gaussian_zs(padded_length);
        std::array<int32_t, 256 * 256> counts0({0});
        std::array<int32_t, 256 * 256> starts0({0});

        const int32_t num_groups = Tz_cam_groups_buffer.size() / 4;
        std::vector<v128_t> Tz_cam_groups(num_groups);

        const v128_t row3 = wasm_f32x4_make(0.0, 0.0, 0.0, 1.0);
        for (int32_t i = 0; i < num_groups; i++) {
            Tz_cam_groups[i] = wasm_v128_load(&Tz_cam_groups_buffer[i * 4]);
        }

        v128_t min_z_i32x4;
        v128_t max_z_i32x4;
        const v128_t splat4096 = wasm_f32x4_splat(4096.0);
        for (int32_t i = 0; i < padded_length; i++) {
            // This should get inlined.
            int32_t gaussianIndex = i * 4;
            const float z0 = dot_f32x4(
                Tz_cam_groups[group_indices[gaussianIndex]],
                centers_homog[gaussianIndex]
            );
            gaussianIndex++;
            const float z1 = dot_f32x4(
                Tz_cam_groups[group_indices[gaussianIndex]],
                centers_homog[gaussianIndex]
            );
            gaussianIndex++;
            const float z2 = dot_f32x4(
                Tz_cam_groups[group_indices[gaussianIndex]],
                centers_homog[gaussianIndex]
            );
            gaussianIndex++;
            const float z3 = dot_f32x4(
                Tz_cam_groups[group_indices[gaussianIndex]],
                centers_homog[gaussianIndex]
            );
            const v128_t cam_z = wasm_f32x4_make(z0, z1, z2, z3);

            // OpenGL camera convention: -Z is forward.
            const v128_t depth = wasm_f32x4_neg(cam_z);
            const v128_t z_int =
                wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(cam_z, splat4096));
            gaussian_zs[i] = z_int;

            if (i == 0) {
                min_z_i32x4 = z_int;
                max_z_i32x4 = z_int;
            } else {
                // Currently, we incorrectly include padding elements in the
                // min/max.
                min_z_i32x4 = wasm_i32x4_min(min_z_i32x4, z_int);
                max_z_i32x4 = wasm_i32x4_max(max_z_i32x4, z_int);
            }
        }
        min_z_i32x4 = wasm_i32x4_splat(min_i32x4(min_z_i32x4));
        max_z_i32x4 = wasm_i32x4_splat(max_i32x4(max_z_i32x4));
        const v128_t z_inv = wasm_f32x4_div(
            wasm_f32x4_splat(256 * 256 - 1),
            wasm_f32x4_add(
                wasm_f32x4_convert_i32x4(
                    wasm_i32x4_sub(max_z_i32x4, min_z_i32x4)
                ),
                wasm_f32x4_splat(1e-5f)
            )
        );
        for (int32_t i = 0; i < padded_length; i++) {
            const v128_t z_bin = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(
                wasm_f32x4_convert_i32x4(
                    wasm_i32x4_sub(gaussian_zs[i], min_z_i32x4)
                ),
                z_inv
            ));
            gaussian_zs[i] = z_bin;
            counts0[wasm_i32x4_extract_lane(z_bin, 0)]++;
            if (i == padded_length - 1) {
                if (i * 4 + 1 < num_gaussians)
                    counts0[wasm_i32x4_extract_lane(z_bin, 1)]++;
                if (i * 4 + 2 < num_gaussians)
                    counts0[wasm_i32x4_extract_lane(z_bin, 2)]++;
                if (i * 4 + 3 < num_gaussians)
                    counts0[wasm_i32x4_extract_lane(z_bin, 3)]++;
            } else {
                counts0[wasm_i32x4_extract_lane(z_bin, 1)]++;
                counts0[wasm_i32x4_extract_lane(z_bin, 2)]++;
                counts0[wasm_i32x4_extract_lane(z_bin, 3)]++;
            }
        }
        for (int32_t i = 1; i < 256 * 256; i++) {
            starts0[i] = starts0[i - 1] + counts0[i - 1];
        }

        // Update and return sorted indices.
        for (int32_t i = 0; i < num_gaussians; i++)
            sorted_indices[starts0[((int32_t *)&gaussian_zs[0])[i]]++] = i;
        return emscripten::val(emscripten::typed_memory_view(
            sorted_indices.size(), &(sorted_indices[0])
        ));
    }
};

EMSCRIPTEN_BINDINGS(c) {
    emscripten::class_<Sorter>("Sorter")
        .constructor<emscripten::val, emscripten::val>()
        .function("setBuffer", &Sorter::setBuffer)
        .function("sort", &Sorter::sort, emscripten::allow_raw_pointers());
};
