"""
Simple GPS Analysis for Rowing Data

This script provides basic analysis of GPS data from rowing sessions.
Input: arrays of lat, lon, time (in milliseconds)
Output: arrays of speed (m/s) and pace (seconds per 500m)

Features:
- Identifies "pause" segments where speed < 1.5 m/s
- Excludes pause segments from all statistics (distance, avg pace, avg speed, etc.)

Usage:
    from gps_analysis import analyze_gps
    
    # Input data (lists or arrays)
    lats = [45.959030, 45.959035, 45.959040, ...]
    lons = [8.870124, 8.870129, 8.870134, ...]
    times_ms = [0, 1000, 2000, ...]  # milliseconds
    
    # Run analysis with pause detection (default: speed < 1.5 m/s is a pause)
    result = analyze_gps(lats, lons, times_ms)
    
    # Run analysis with custom pause threshold
    result = analyze_gps(lats, lons, times_ms, pause_threshold=1.0)
    
    # Disable pause detection
    result = analyze_gps(lats, lons, times_ms, pause_threshold=None)
    
    # Output
    print(f"Total distance: {result['total_distance']} m")
    print(f"Total moving distance: {result['moving_distance']} m")
    print(f"Total time: {result['total_time']} s")
    print(f"Moving time: {result['moving_time']} s")
    print(f"Average speed: {result['avg_speed']} m/s")
    print(f"Average pace: {result['avg_pace']} s/500m")
    print(f"Pause percentage: {result['pause_percentage']:.1f}%")
    
    # Access speed and pace arrays
    speeds = result['speeds']  # list of speeds in m/s
    paces = result['paces']    # list of paces in seconds per 500m
    is_pause = result['is_pause']  # list of booleans indicating pause points
"""

import math

# Default pause threshold: speeds below this are considered "pauses"
DEFAULT_PAUSE_THRESHOLD = 1.5  # m/s


def haversine(lat1, lon1, lat2, lon2):
    """
    Calculate distance between two GPS coordinates in meters.
    
    Args:
        lat1, lon1: First point in decimal degrees
        lat2, lon2: Second point in decimal degrees
        
    Returns:
        Distance in meters
    """
    R = 6371000  # Earth radius in meters
    
    # Convert to radians
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    
    # Haversine formula
    a = (math.sin(delta_phi / 2) ** 2 + 
         math.cos(phi1) * math.cos(phi2) * 
         math.sin(delta_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    return R * c


def analyze_gps(lats, lons, times_ms, pause_threshold=DEFAULT_PAUSE_THRESHOLD):
    """
    Analyze GPS data to compute distance, speed, and pace.
    
    Identifies "pause" segments where speed < pause_threshold and excludes them
    from all statistics (distance, avg pace, avg speed, etc.).
    
    Args:
        lats: List of latitude values in decimal degrees
        lons: List of longitude values in decimal degrees
        times_ms: List of time values in milliseconds
        pause_threshold: Speed threshold in m/s below which points are considered pauses.
                         Set to None to disable pause detection. Default: 1.5 m/s
        
    Returns:
        Dictionary with:
        - total_distance: Total distance in meters (including pauses)
        - moving_distance: Total distance in meters (excluding pauses)
        - total_time: Total time in seconds (including pauses)
        - moving_time: Total time in seconds (excluding pauses)
        - avg_speed: Average speed in m/s (excluding pauses, based on moving_time)
        - avg_pace: Average pace in seconds per 500m (excluding pauses)
        - speeds: List of instantaneous speeds in m/s
        - paces: List of instantaneous paces in seconds per 500m
        - distances: List of cumulative distances in meters (including pauses)
        - moving_distances: List of cumulative distances in meters (excluding pauses)
        - is_pause: List of booleans indicating if each point is a pause
        - pause_percentage: Percentage of time spent in pauses
        - pause_count: Number of pause segments detected
    """
    if len(lats) < 2 or len(lons) < 2 or len(times_ms) < 2:
        return {
            'total_distance': 0.0,
            'moving_distance': 0.0,
            'total_time': 0.0,
            'moving_time': 0.0,
            'avg_speed': 0.0,
            'avg_pace': 0.0,
            'speeds': [],
            'paces': [],
            'distances': [],
            'moving_distances': [],
            'is_pause': [],
            'pause_percentage': 0.0,
            'pause_count': 0
        }
    
    # Initialize
    total_distance = 0.0
    moving_distance = 0.0
    speeds = []
    paces = []
    distances = [0.0]
    moving_distances = [0.0]
    is_pause = [False]  # First point is never a pause (no speed yet)
    
    # Calculate distance and speed between consecutive points
    for i in range(len(lats) - 1):
        # Distance between points
        dist = haversine(lats[i], lons[i], lats[i+1], lons[i+1])
        total_distance += dist
        
        # Time difference in seconds
        time_diff = (times_ms[i+1] - times_ms[i]) / 1000.0
        
        # Speed in m/s (only if time_diff > 0)
        if time_diff > 0:
            speed = dist / time_diff
            speeds.append(speed)
            
            # Pace in seconds per 500m (only if speed > 0)
            if speed > 0:
                pace = 500.0 / speed
                paces.append(pace)
            else:
                paces.append(0.0)
        else:
            speeds.append(0.0)
            paces.append(0.0)
        
        # Cumulative distance (always includes this segment)
        distances.append(total_distance)
        
        # Determine if this segment is a pause
        current_speed = speeds[-1] if speeds else 0.0
        if pause_threshold is not None and current_speed < pause_threshold:
            # This is a pause segment
            is_pause.append(True)
            # Don't add to moving distance
            moving_distances.append(moving_distances[-1])
        else:
            # This is a moving segment
            is_pause.append(False)
            moving_distance += dist
            moving_distances.append(moving_distance)
        
        # Cumulative distance
    
    # Total time in seconds
    total_time = (times_ms[-1] - times_ms[0]) / 1000.0
    
    # Calculate moving time (time spent not in pauses)
    moving_time = 0.0
    if pause_threshold is not None:
        for i in range(len(lats) - 1):
            time_diff = (times_ms[i+1] - times_ms[i]) / 1000.0
            if not is_pause[i + 1]:  # is_pause[i+1] corresponds to segment i->i+1
                moving_time += time_diff
    else:
        moving_time = total_time
    
    # Count pause segments (consecutive pause points count as one segment)
    pause_count = 0
    in_pause = False
    for i in range(1, len(is_pause)):
        if is_pause[i] and not in_pause:
            pause_count += 1
            in_pause = True
        elif not is_pause[i]:
            in_pause = False
    
    # Calculate pause percentage
    if total_time > 0:
        pause_percentage = ((total_time - moving_time) / total_time) * 100.0
    else:
        pause_percentage = 0.0
    
    # Average speed (based on moving distance and moving time)
    if moving_time > 0:
        avg_speed = moving_distance / moving_time
    else:
        avg_speed = 0.0
    
    # Average pace (based on moving speed)
    if avg_speed > 0:
        avg_pace = 500.0 / avg_speed
    else:
        avg_pace = 0.0
    
    return {
        'total_distance': total_distance,
        'moving_distance': moving_distance,
        'total_time': total_time,
        'moving_time': moving_time,
        'avg_speed': avg_speed,
        'avg_pace': avg_pace,
        'speeds': speeds,
        'paces': paces,
        'distances': distances,
        'moving_distances': moving_distances,
        'is_pause': is_pause,
        'pause_percentage': pause_percentage,
        'pause_count': pause_count
    }


def format_pace(pace_seconds):
    """
    Format pace in mm:ss.d format.
    
    Args:
        pace_seconds: Pace in seconds per 500m
        
    Returns:
        Formatted string like "1:45.25"
    """
    minutes = int(pace_seconds // 60)
    seconds = pace_seconds % 60
    return f"{minutes}:{seconds:05.2f}"


def format_time(seconds):
    """
    Format time in mm:ss format.
    
    Args:
        seconds: Time in seconds
        
    Returns:
        Formatted string like "10:30"
    """
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{minutes}:{secs:02d}"


# Example usage
if __name__ == '__main__':
    # Test with sample data
    lats = [45.959030, 45.959035, 45.959040, 45.959045]
    lons = [8.870124, 8.870129, 8.870134, 8.870139]
    times_ms = [0, 1000, 2000, 3000]
    
    print("=" * 60)
    print("GPS Analysis with Pause Detection (default threshold: 1.5 m/s)")
    print("=" * 60)
    result = analyze_gps(lats, lons, times_ms)
    
    print("\nBasic Statistics:")
    print(f"  Total distance: {result['total_distance']:.2f} m")
    print(f"  Moving distance: {result['moving_distance']:.2f} m")
    print(f"  Total time: {result['total_time']:.2f} s")
    print(f"  Moving time: {result['moving_time']:.2f} s")
    print(f"  Average speed (moving): {result['avg_speed']:.4f} m/s")
    print(f"  Average pace (moving): {format_pace(result['avg_pace'])} /500m")
    
    print("\nPause Statistics:")
    print(f"  Pause percentage: {result['pause_percentage']:.1f}%")
    print(f"  Pause count: {result['pause_count']}")
    
    print(f"\n  Number of speed samples: {len(result['speeds'])}")
    print(f"  Number of pace samples: {len(result['paces'])}")
    print(f"  Pause flags: {result['is_pause']}")
    
    # Test with custom threshold
    print("\n" + "=" * 60)
    print("GPS Analysis with Custom Threshold (0.5 m/s)")
    print("=" * 60)
    result2 = analyze_gps(lats, lons, times_ms, pause_threshold=0.5)
    
    print(f"  Moving distance: {result2['moving_distance']:.2f} m")
    print(f"  Pause percentage: {result2['pause_percentage']:.1f}%")
    print(f"  Pause flags: {result2['is_pause']}")
    
    # Test without pause detection
    print("\n" + "=" * 60)
    print("GPS Analysis without Pause Detection")
    print("=" * 60)
    result3 = analyze_gps(lats, lons, times_ms, pause_threshold=None)
    
    print(f"  Total distance: {result3['total_distance']:.2f} m")
    print(f"  Moving distance: {result3['moving_distance']:.2f} m")
    print(f"  Pause percentage: {result3['pause_percentage']:.1f}%")
