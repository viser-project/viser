import React, { useCallback, useRef, useState } from "react";
import {
  Box,
  useMantineTheme,
  useMantineColorScheme,
  Tooltip,
} from "@mantine/core";
import "./MultiSliderComponent.css";

interface MultiSliderProps {
  min: number;
  max: number;
  step?: number;
  value: number[];
  onChange: (value: number[]) => void;
  marks?: { value: number; label?: string | null }[] | null;
  fixedEndpoints?: boolean;
  minRange?: number;
  precision?: number;
  id?: string;
  className?: string;
  disabled?: boolean;
  pt?: string;
  pb?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function MultiSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  marks,
  fixedEndpoints = false,
  minRange,
  precision = 2,
  id,
  className,
  disabled = false,
  pt,
  pb,
}: MultiSliderProps) {
  const [activeThumb, setActiveThumb] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();

  const getPercentage = (val: number) => {
    return ((val - min) / (max - min)) * 100;
  };

  const getValueFromPosition = (clientX: number) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const percentage = (clientX - rect.left) / rect.width;
    const rawValue = percentage * (max - min) + min;

    // Round to step.
    if (step) {
      return Math.round(rawValue / step) * step;
    }
    return parseFloat(rawValue.toFixed(precision));
  };

  const findClosestThumb = (targetValue: number) => {
    if (value.length === 0) return -1;

    let minDistance = Infinity;
    let closestIndex = 0;

    value.forEach((val, index) => {
      const distance = Math.abs(val - targetValue);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = index;
      }
    });

    return closestIndex;
  };

  const updateValue = useCallback(
    (newValue: number, thumbIndex: number) => {
      const newValues = [...value];
      newValues[thumbIndex] = clamp(newValue, min, max);

      // Apply constraints.
      const _minRange = minRange || step;

      // Prevent overlapping with next thumb.
      if (
        thumbIndex < newValues.length - 1 &&
        newValues[thumbIndex] > newValues[thumbIndex + 1] - _minRange
      ) {
        newValues[thumbIndex] = newValues[thumbIndex + 1] - _minRange;
      }

      // Prevent overlapping with previous thumb.
      if (
        thumbIndex > 0 &&
        newValues[thumbIndex] < newValues[thumbIndex - 1] + _minRange
      ) {
        newValues[thumbIndex] = newValues[thumbIndex - 1] + _minRange;
      }

      // Respect fixed endpoints.
      if (
        fixedEndpoints &&
        (thumbIndex === 0 || thumbIndex === newValues.length - 1)
      ) {
        return;
      }

      onChange(newValues);
    },
    [value, onChange, min, max, step, minRange, fixedEndpoints],
  );

  const handleMouseDown = (event: React.MouseEvent) => {
    if (disabled || value.length === 0) return;

    const targetValue = getValueFromPosition(event.clientX);
    const thumbIndex = findClosestThumb(targetValue);
    if (thumbIndex === -1) return;

    setActiveThumb(thumbIndex);

    const handleMouseMove = (e: MouseEvent) => {
      const newValue = getValueFromPosition(e.clientX);
      updateValue(newValue, thumbIndex);
    };

    const handleMouseUp = () => {
      setActiveThumb(null);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const handleThumbMouseDown = (event: React.MouseEvent, index: number) => {
    event.stopPropagation();
    if (disabled || value.length === 0 || index >= value.length) return;

    setActiveThumb(index);

    const handleMouseMove = (e: MouseEvent) => {
      const newValue = getValueFromPosition(e.clientX);
      updateValue(newValue, index);
    };

    const handleMouseUp = () => {
      setActiveThumb(null);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <Box
      id={id}
      className={`multi-slider ${className || ""} ${
        disabled ? "disabled" : ""
      }`}
      pt={pt}
      pb={pb}
    >
      <div
        ref={containerRef}
        className="multi-slider-track-container"
        onMouseDown={handleMouseDown}
      >
        <div className="multi-slider-track" />

        {/* Render thumbs */}
        {value.map((val, index) => (
          <Tooltip
            key={`thumb-${index}`}
            label={val.toFixed(precision)}
            opened={activeThumb === index}
            position="top"
            offset={10}
            transitionProps={{ transition: "fade", duration: 0 }}
            withinPortal
          >
            <div
              className={`multi-slider-thumb ${
                activeThumb === index ? "active" : ""
              }`}
              style={{
                left: `${getPercentage(val)}%`,
                backgroundColor: disabled
                  ? undefined
                  : theme.colors[theme.primaryColor][
                      colorScheme === "dark" ? 5 : 6
                    ],
              }}
              onMouseDown={(e) => handleThumbMouseDown(e, index)}
            />
          </Tooltip>
        ))}

        {/* Render marks */}
        {marks &&
          marks.map((mark, index) => (
            <div
              key={`mark-${index}`}
              className="multi-slider-mark-wrapper"
              style={{
                left: `${getPercentage(mark.value)}%`,
              }}
            >
              <div className="multi-slider-mark" />
              {mark.label && mark.label !== null && (
                <div className="multi-slider-mark-label">{mark.label}</div>
              )}
            </div>
          ))}
      </div>
    </Box>
  );
}
