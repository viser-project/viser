export function MacWindowWrapper({
  children,
  title,
  width,
  height,
  fill = false,
}: {
  children: React.ReactNode;
  title: string;
  width: number;
  height: number;
  fill?: boolean;
}) {
  const TITLEBAR_HEIGHT = 36; // px

  return (
    <div
      style={{
        width: fill ? "100vw" : `${width}px`,
        height: fill ? "100vh" : `${height}px`,
        borderRadius: "10px",
        overflow: "hidden",
        // boxShadow: "0 3px 10px rgba(0,0,0,0.1)",
        border: "1px solid rgba(0,0,0,0.2)",
        backgroundColor: "white",
        transform: "translateX(-50%) translateY(-50%)",
        top: "50%",
        left: "50%",
        position: "absolute",
      }}
    >
      {/* MacOS titlebar */}
      <div
        style={{
          height: `${TITLEBAR_HEIGHT}px`,
          backgroundColor: "#f6f6f6",
          borderBottom: "1px solid rgba(0,0,0,0.075)",
          display: "flex",
          alignItems: "center",
          paddingLeft: "12px",
          gap: "8px",
        }}
      >
        {/* Traffic light buttons */}
        <div
          style={{
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            backgroundColor: "#ff5f57",
          }}
        />
        <div
          style={{
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            backgroundColor: "#febc2e",
          }}
        />
        <div
          style={{
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            backgroundColor: "#28c840",
          }}
        />
        {/* Window title */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            color: "#000",
            opacity: 0.4,
            fontSize: "14px",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            fontWeight: 500,
          }}
        >
          {title}
        </div>
      </div>
      {/* Content */}
      <div style={{ height: `calc(100% - ${TITLEBAR_HEIGHT}px)` }}>
        {children}
      </div>
    </div>
  );
}
