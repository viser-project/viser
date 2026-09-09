import * as React from "react";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { GuiTableDataMessage } from "../WebsocketMessages";
import { Table, TextInput, NumberInput, Box } from "@mantine/core";

type CellValue = string | number;
type TableData = CellValue[][];

export default function TableDataComponent({
  uuid,
  value,
  props: { hint, label, disabled, visible, columns, selection_mode },
}: GuiTableDataMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  const [selectedRow, setSelectedRow] = React.useState<number>(-1);
  const [editingCell, setEditingCell] = React.useState<{
    row: number;
    col: number;
  } | null>(null);
  const [editValue, setEditValue] = React.useState<CellValue>("");

  if (!visible) return null;

  const tableData: TableData = value.map((row) => [...row]);

  const commitCellChange = (
    rowIdx: number,
    colIdx: number,
    newValue: CellValue,
  ) => {
    const newData = tableData.map((row, i) =>
      i === rowIdx
        ? row.map((cell, j) => (j === colIdx ? newValue : cell))
        : row,
    );
    setValue(
      uuid,
      newData.map((row) => [...row]),
    );
  };

  const finishEditing = () => {
    if (editingCell !== null) {
      commitCellChange(editingCell.row, editingCell.col, editValue);
    }
    setEditingCell(null);
  };

  const startEditing = (
    rowIdx: number,
    colIdx: number,
    initialValue: CellValue,
  ) => {
    setEditingCell({ row: rowIdx, col: colIdx });
    setEditValue(initialValue);
  };

  const handleRowClick = (rowIdx: number) => {
    if (selection_mode === "none" || disabled) return;

    const newSelectedRow = selectedRow === rowIdx ? -1 : rowIdx;
    setSelectedRow(newSelectedRow);

    // TODO: Send selection to backend for callback support
    // For now, selection is only tracked in frontend state
  };

  const renderCell = (
    cellValue: CellValue,
    rowIdx: number,
    colIdx: number,
    editable: boolean,
    cellType: "string" | "number",
  ) => {
    const isEditing =
      editingCell?.row === rowIdx && editingCell?.col === colIdx;

    if (!editable || disabled) {
      return <Box style={{ padding: "4px 8px" }}>{String(cellValue)}</Box>;
    }

    if (isEditing) {
      if (cellType === "number") {
        return (
          <NumberInput
            value={Number(editValue)}
            onChange={(val) => val !== "" && setEditValue(Number(val))}
            onBlur={finishEditing}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                finishEditing();
              } else if (e.key === "Escape") {
                setEditingCell(null);
              }
            }}
            size="xs"
            autoFocus
            styles={{ input: { padding: "2px 8px" } }}
          />
        );
      } else {
        return (
          <TextInput
            value={String(editValue)}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={finishEditing}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                finishEditing();
              } else if (e.key === "Escape") {
                setEditingCell(null);
              }
            }}
            size="xs"
            autoFocus
            styles={{ input: { padding: "2px 8px" } }}
          />
        );
      }
    }

    return (
      <Box
        onClick={() => startEditing(rowIdx, colIdx, cellValue)}
        style={{
          padding: "4px 8px",
          cursor: "pointer",
          minHeight: "1.625rem",
        }}
      >
        {String(cellValue)}
      </Box>
    );
  };

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <Box style={{ maxHeight: "400px", overflowY: "auto" }}>
        <Table
          striped
          highlightOnHover={selection_mode === "single"}
          withTableBorder
          withColumnBorders
          style={{ fontSize: "0.875rem" }}
        >
          <Table.Thead>
            <Table.Tr>
              {columns.map((col, idx) => (
                <Table.Th key={idx}>{col.title}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tableData.map((row, rowIdx) => (
              <Table.Tr
                key={rowIdx}
                onClick={() => handleRowClick(rowIdx)}
                style={{
                  backgroundColor:
                    selectedRow === rowIdx
                      ? "var(--mantine-color-blue-light)"
                      : undefined,
                  cursor:
                    selection_mode === "single" && !disabled
                      ? "pointer"
                      : undefined,
                }}
              >
                {row.map((cell, colIdx) => (
                  <Table.Td key={colIdx}>
                    {renderCell(
                      cell,
                      rowIdx,
                      colIdx,
                      columns[colIdx].editable,
                      columns[colIdx].cell_type,
                    )}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </ViserInputComponent>
  );
}
